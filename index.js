const express = require('express')

module.exports = function (app) {
  let timer = null

  // Plugin runtime state
  let enabled = false
  let mode = 'BOD' // 'BOD' (heading hold) or 'APB' (track hold)

  // BOD target
  let targetMagDeg = null

  // Track-hold (APB) state
  let trackActive = false
  let trackStart = null // { lat, lon }
  let trackBearingMagDeg = null // desired rhumb bearing (mag)
  let trackBearingTrueDeg = null // optional (if variation known)
  let trackName = 'RHUMB'

  // Debug/status
  let lastSentence = null
  let lastEmitTs = null
  let lastStatus = null

  const plugin = {
    id: 'signalk-hts-bod-apb',
    name: 'Autopilot HTS: BOD (Heading) + APB (Track Hold)',
    description:
      'Outputs NMEA0183 BOD for heading hold and APB for rhumb-line track hold, using best-available Signal K sources.',
    schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', title: 'Enable output', default: false },
        defaultMode: {
          type: 'string',
          title: 'Default mode',
          default: 'BOD',
          enum: ['BOD', 'APB']
        },
        rateHz: {
          type: 'number',
          title: 'Output rate (Hz)',
          default: 1,
          minimum: 0.2,
          maximum: 10
        },
        talker: { type: 'string', title: 'Talker ID (2 chars)', default: 'II' },
        gpsStaleSeconds: {
          type: 'number',
          title: 'GPS stale threshold (seconds)',
          default: 5,
          minimum: 1,
          maximum: 60
        },
        // Path preferences (advanced users can override)
        path_position: { type: 'string', title: 'Position path', default: 'navigation.position' },
        path_cogMag: {
          type: 'string',
          title: 'COG magnetic path',
          default: 'navigation.courseOverGroundMagnetic'
        },
        path_cogTrue: {
          type: 'string',
          title: 'COG true path',
          default: 'navigation.courseOverGroundTrue'
        },
        path_hdgMag: {
          type: 'string',
          title: 'Heading magnetic path',
          default: 'navigation.headingMagnetic'
        },
        path_hdgTrue: {
          type: 'string',
          title: 'Heading true path',
          default: 'navigation.headingTrue'
        },
        path_variation: {
          type: 'string',
          title: 'Magnetic variation path',
          default: 'navigation.magneticVariation'
        }
      }
    },

    start: function (options) {
      enabled = !!options.enabled
      mode = options.defaultMode === 'APB' ? 'APB' : 'BOD'

      const rateHz = Number(options.rateHz || 1)
      const talker = sanitizeTalker(options.talker || 'II')
      const gpsStaleSeconds = Number(options.gpsStaleSeconds || 5)

      const PATHS = {
        position: options.path_position || 'navigation.position',
        cogMag: options.path_cogMag || 'navigation.courseOverGroundMagnetic',
        cogTrue: options.path_cogTrue || 'navigation.courseOverGroundTrue',
        hdgMag: options.path_hdgMag || 'navigation.headingMagnetic',
        hdgTrue: options.path_hdgTrue || 'navigation.headingTrue',
        variation: options.path_variation || 'navigation.magneticVariation'
      }

      // ---------- Web UI ----------
      const router = express.Router()

      router.get('/', (_req, res) => {
        res.type('html').send(uiHtml())
      })

      router.get('/state', (_req, res) => {
        const status = computeStatus(PATHS, gpsStaleSeconds)
        res.json({
          enabled,
          mode,
          targetMagDeg,
          trackActive,
          trackStart,
          trackBearingMagDeg,
          trackBearingTrueDeg,
          lastSentence,
          lastEmitTs,
          status
        })
      })

      router.post('/cmd', express.json(), (req, res) => {
        const c = req.body?.c
        const v = req.body?.v

        if (c === 'enable') enabled = true
        if (c === 'disable') enabled = false
        if (c === 'mode_bod') mode = 'BOD'
        if (c === 'mode_apb') mode = 'APB'

        const status = computeStatus(PATHS, gpsStaleSeconds)

        // Helpers:
        const curHeadingMag = status.best.headingMagDeg
        const curCogMag = status.best.cogMagDeg
        const curPos = status.best.position

        // ----- BOD controls -----
        if (c === 'hold_heading') {
          if (curHeadingMag != null) {
            targetMagDeg = curHeadingMag
            mode = 'BOD'
            trackActive = false
          }
        }
        if (c === 'set_heading') {
          const n = Number(v)
          if (Number.isFinite(n)) {
            targetMagDeg = wrap360(n)
            mode = 'BOD'
            trackActive = false
          }
        }
        if (c === 'clear_heading') {
          targetMagDeg = null
        }

        // ----- Track hold controls -----
        if (c === 'hold_rhumb') {
          // Require fresh GPS position
          if (curPos && status.best.positionFresh) {
            // Track bearing preference: COGmag if available, else heading mag
            const bearingMag = curCogMag != null ? curCogMag : curHeadingMag
            if (bearingMag != null) {
              trackStart = { lat: curPos.lat, lon: curPos.lon }
              trackBearingMagDeg = wrap360(bearingMag)
              // If variation known, compute true for APB field
              if (status.best.variationDeg != null) {
                trackBearingTrueDeg = wrap360(trackBearingMagDeg + status.best.variationDeg)
              } else {
                trackBearingTrueDeg = null
              }
              trackActive = true
              mode = 'APB'
              // When in track mode, we do not use BOD target
              targetMagDeg = null
            }
          }
        }
        if (c === 'stop_track') {
          trackActive = false
          trackStart = null
          trackBearingMagDeg = null
          trackBearingTrueDeg = null
        }

        // ----- Adjustments apply to whichever mode is active -----
        const delta =
          c === 'p1' ? 1 : c === 'm1' ? -1 : c === 'p10' ? 10 : c === 'm10' ? -10 : 0
        if (delta !== 0) {
          if (mode === 'BOD' && targetMagDeg != null) targetMagDeg = wrap360(targetMagDeg + delta)
          if (mode === 'APB' && trackActive && trackBearingMagDeg != null) {
            trackBearingMagDeg = wrap360(trackBearingMagDeg + delta)
            if (status.best.variationDeg != null) {
              trackBearingTrueDeg = wrap360(trackBearingMagDeg + status.best.variationDeg)
            } else {
              trackBearingTrueDeg = null
            }
          }
        }

        const status2 = computeStatus(PATHS, gpsStaleSeconds)
        res.json({
          enabled,
          mode,
          targetMagDeg,
          trackActive,
          trackStart,
          trackBearingMagDeg,
          trackBearingTrueDeg,
          lastSentence,
          lastEmitTs,
          status: status2
        })
      })

      app.registerRouter(router, '/plugins/hts')

      // ---------- Output loop ----------
      stopTimer()
      const periodMs = Math.max(100, Math.round(1000 / rateHz))
      timer = setInterval(() => {
        const status = computeStatus(PATHS, gpsStaleSeconds)
        lastStatus = status

        if (!enabled) return

        // Safety: only emit if we have an active target for the current mode
        if (mode === 'BOD') {
          if (targetMagDeg == null) return
          const variationDeg = status.best.variationDeg
          const trueDeg = variationDeg != null ? wrap360(targetMagDeg + variationDeg) : null

          const sentence = buildBOD({
            talker,
            trueDeg,
            magDeg: targetMagDeg,
            dest: 'DEST',
            orig: 'ORIG'
          })

          emit(sentence)
          return
        }

        if (mode === 'APB') {
          if (!trackActive || !trackStart || trackBearingMagDeg == null) return
          // Need fresh position to compute XTE
          if (!status.best.positionFresh || !status.best.position) return

          const cur = status.best.position
          const xte = computeXteNmAndSide(trackStart, cur, trackBearingMagDeg)

          // For APB: include HTS mag and (optionally) true
          const htsMag = trackBearingMagDeg
          const htsTrue =
            status.best.variationDeg != null ? wrap360(trackBearingMagDeg + status.best.variationDeg) : null

          const sentence = buildAPB({
            talker,
            xteNm: xte.nm,
            xteSide: xte.side, // 'L' or 'R'
            htsMagDeg: htsMag,
            htsTrueDeg: htsTrue,
            destId: trackName
          })

          emit(sentence)
        }
      }, periodMs)

      app.setPluginStatus('Running. UI: /plugins/hts')
    },

    stop: function () {
      stopTimer()
      app.setPluginStatus('Stopped')
    }
  }

  function emit(sentence) {
    lastSentence = sentence.trim()
    lastEmitTs = new Date().toISOString()
    app.emit('nmea0183out', sentence)
  }

  function stopTimer() {
    if (timer) clearInterval(timer)
    timer = null
  }

  function sanitizeTalker(t) {
    const up = String(t || 'II').toUpperCase().replace(/[^A-Z0-9]/g, '')
    return up.length >= 2 ? up.slice(0, 2) : 'II'
  }

  // ---------- Best-available status selection ----------

  function computeStatus(PATHS, gpsStaleSeconds) {
    const now = Date.now()

    const pos = readPosition(PATHS.position)
    const posFresh = pos && pos.timestampMs != null ? now - pos.timestampMs <= gpsStaleSeconds * 1000 : false

    const variation = readAngleDeg(PATHS.variation) // degrees, east positive (if present)
    const cogMag = readAngleDeg(PATHS.cogMag)
    const cogTrue = readAngleDeg(PATHS.cogTrue)
    const hdgMag = readAngleDeg(PATHS.hdgMag)
    const hdgTrue = readAngleDeg(PATHS.hdgTrue)

    // Best available COG magnetic
    let bestCogMagDeg = cogMag
    let cogSource = cogMag != null ? PATHS.cogMag : null
    if (bestCogMagDeg == null && cogTrue != null && variation != null) {
      bestCogMagDeg = wrap360(cogTrue - variation) // True -> Mag: Mag = True - Var (east-positive)
      cogSource = `${PATHS.cogTrue} + variation`
    }
    if (bestCogMagDeg == null && hdgMag != null) {
      // last resort (not truly O/G track, but better than nothing)
      bestCogMagDeg = hdgMag
      cogSource = `${PATHS.hdgMag} (fallback)`
    }

    // Best available heading magnetic
    let bestHdgMagDeg = hdgMag
    let hdgSource = hdgMag != null ? PATHS.hdgMag : null
    if (bestHdgMagDeg == null && hdgTrue != null && variation != null) {
      bestHdgMagDeg = wrap360(hdgTrue - variation)
      hdgSource = `${PATHS.hdgTrue} + variation`
    }

    const status = {
      nowIso: new Date(now).toISOString(),
      paths: PATHS,
      raw: {
        position: pos ? { lat: pos.lat, lon: pos.lon, timestampMs: pos.timestampMs } : null,
        positionAgeMs: pos && pos.timestampMs != null ? now - pos.timestampMs : null,
        variationDeg: variation,
        cogMagDeg: cogMag,
        cogTrueDeg: cogTrue,
        hdgMagDeg: hdgMag,
        hdgTrueDeg: hdgTrue
      },
      best: {
        position: pos ? { lat: pos.lat, lon: pos.lon } : null,
        positionFresh: !!posFresh,
        variationDeg: variation,
        cogMagDeg: bestCogMagDeg,
        cogMagSource: cogSource,
        headingMagDeg: bestHdgMagDeg,
        headingMagSource: hdgSource
      }
    }
    return status
  }

  function readPosition(path) {
    const v = app.getSelfPath(path)?.value
    if (!v || typeof v !== 'object') return null
    const lat = Number(v.latitude)
    const lon = Number(v.longitude)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

    // Try to get a timestamp: some installs include it in meta, others not.
    // Signal K usually stores timestamps in the delta updates; getSelfPath may include it in "timestamp".
    const ts = app.getSelfPath(path)?.timestamp
    const timestampMs = ts ? Date.parse(ts) : null

    return { lat, lon, timestampMs: Number.isFinite(timestampMs) ? timestampMs : null }
  }

  // Read an angle and return degrees (0..359.9). Accepts radians or degrees.
  function readAngleDeg(path) {
    const v = app.getSelfPath(path)?.value
    if (v == null) return null
    const num = Number(v)
    if (!Number.isFinite(num)) return null
    // Heuristic: treat as radians if within ~2π
    const deg = Math.abs(num) <= Math.PI * 2 + 0.5 ? radToDeg(num) : num
    return wrap360(deg)
  }

  const radToDeg = (r) => (r * 180) / Math.PI

  function wrap360(deg) {
    let d = deg % 360
    if (d < 0) d += 360
    return Math.round(d * 10) / 10
  }

  // ---------- Track math: cross-track error to a rhumb line ----------

  function computeXteNmAndSide(start, cur, bearingMagDeg) {
    // Local tangent plane approximation around start point.
    // Convert delta lat/lon to meters in N/E.
    const lat0 = degToRad(start.lat)
    const dLat = degToRad(cur.lat - start.lat)
    const dLon = degToRad(cur.lon - start.lon)

    // Earth radius (m)
    const R = 6371000
    const dN = dLat * R
    const dE = dLon * R * Math.cos(lat0)

    // Track angle theta: 0 = North, 90 = East
    const theta = degToRad(bearingMagDeg)

    // Cross track (meters). Sign convention:
    // xte_m > 0 => Right of track, xte_m < 0 => Left of track (with this formula).
    const xte_m = -Math.sin(theta) * dE + Math.cos(theta) * dN

    const nm = Math.min(Math.abs(xte_m) / 1852, 9.99) // clamp to 9.99nm for sentence formatting
    const side = xte_m >= 0 ? 'R' : 'L'
    return { nm: round2(nm), side }
  }

  const degToRad = (d) => (d * Math.PI) / 180
  const round2 = (n) => Math.round(n * 100) / 100

  // ---------- NMEA builders (BOD + APB) ----------

  function fmtDeg(deg) {
    // "083.4" format
    const d = wrap360(deg)
    return d.toFixed(1).padStart(5, '0')
  }

  function fmtXteNm(nm) {
    // "0.01" format
    const n = Math.max(0, Math.min(9.99, nm))
    return n.toFixed(2)
  }

  function buildBOD({ talker, trueDeg, magDeg, dest, orig }) {
    const tField = trueDeg != null ? fmtDeg(trueDeg) : ''
    const mField = magDeg != null ? fmtDeg(magDeg) : ''
    const body = `${talker}BOD,${tField},T,${mField},M,${dest || ''},${orig || ''}`
    return addChecksum(`$${body}`)
  }

  function buildAPB({ talker, xteNm, xteSide, htsMagDeg, htsTrueDeg, destId }) {
    // Use the structure shown in CM550 manual for APB:
    // $**APB,A,A,D.DD,D,N,A,A,DDD,M,XXXX,XXX,M,XXX,M
    // We'll fill:
    //   status: A,A
    //   xte: nn.nn, side(L/R), units N
    //   arrival/perp: A,A (not actively computed)
    //   heading-to-steer: true (if known) + mag (required)
    //   destId as waypoint id field
    const xte = fmtXteNm(xteNm)
    const side = xteSide === 'L' ? 'L' : 'R'
    const htsT = htsTrueDeg != null ? fmtDeg(htsTrueDeg) : ''
    const htsM = htsMagDeg != null ? fmtDeg(htsMagDeg) : ''

    // Fields after htsM vary between implementations; CM550 ignores most other numeric data.
    // Provide destId and leave the rest blank but syntactically valid.
    const body = `${talker}APB,A,A,${xte},${side},N,A,A,${htsT},T,${htsM},M,${destId || ''},,,`
    return addChecksum(`$${body}`)
  }

  function addChecksum(sentence) {
    let c = 0
    for (let i = 1; i < sentence.length; i++) c ^= sentence.charCodeAt(i)
    const hex = c.toString(16).toUpperCase().padStart(2, '0')
    return `${sentence}*${hex}\r\n`
  }

  // ---------- UI ----------

  function uiHtml() {
    return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body{font-family:system-ui;margin:16px;max-width:900px}
  button{font-size:16px;padding:10px 14px;margin:6px}
  .row{margin:10px 0}
  input,select{font-size:16px;padding:8px}
  .pill{display:inline-block;padding:4px 10px;border-radius:999px;background:#eee;margin:4px 8px 4px 0}
  pre{background:#f6f6f6;padding:10px;border-radius:8px;overflow:auto}
  .card{border:1px solid #ddd;border-radius:12px;padding:12px;margin:12px 0}
  .warn{background:#fff3cd;border:1px solid #ffeeba}
</style>
</head>
<body>
<h2>Autopilot HTS Output (BOD + APB)</h2>

<div class="card">
  <div class="row">
    <span class="pill">Enabled: <b id="en">--</b></span>
    <span class="pill">Mode: <b id="mode">--</b></span>
  </div>
  <div class="row">
    <button onclick="cmd('enable')">ENABLE</button>
    <button onclick="cmd('disable')">DISABLE</button>
    <button onclick="cmd('mode_bod')">MODE: HEADING (BOD)</button>
    <button onclick="cmd('mode_apb')">MODE: TRACK (APB)</button>
  </div>
</div>

<div class="card">
  <h3>Heading Hold (BOD)</h3>
  <div class="row">
    <span class="pill">Current heading mag: <b id="hdg">--</b>°</span>
    <span class="pill">Target heading mag: <b id="tgt">--</b>°</span>
  </div>
  <div class="row">
    <button onclick="cmd('hold_heading')">HOLD (use current heading)</button>
    <button onclick="cmd('m1')">-1</button>
    <button onclick="cmd('p1')">+1</button>
    <button onclick="cmd('m10')">-10</button>
    <button onclick="cmd('p10')">+10</button>
    <button onclick="cmd('clear_heading')">CLEAR</button>
  </div>
  <div class="row">
    <input id="setHeading" type="number" min="0" max="359" placeholder="Set deg" />
    <button onclick="cmd('set_heading', document.getElementById('setHeading').value)">SET</button>
  </div>
</div>

<div class="card">
  <h3>Track Hold (APB) – Hold Rhumb Line</h3>
  <div class="row">
    <span class="pill">GPS fresh: <b id="gpsFresh">--</b></span>
    <span class="pill">COG mag used: <b id="cog">--</b>°</span>
  </div>
  <div class="row">
    <span class="pill">Track active: <b id="trkOn">--</b></span>
    <span class="pill">Track bearing mag: <b id="trkBrg">--</b>°</span>
    <span class="pill">Start: <b id="trkStart">--</b></span>
  </div>
  <div class="row">
    <button onclick="cmd('hold_rhumb')">HOLD RHUMB (capture start + bearing)</button>
    <button onclick="cmd('stop_track')">STOP TRACK</button>
    <button onclick="cmd('m1')">-1</button>
    <button onclick="cmd('p1')">+1</button>
    <button onclick="cmd('m10')">-10</button>
    <button onclick="cmd('p10')">+10</button>
  </div>
  <div class="row warn">
    <b>Note:</b> Track hold requires fresh GPS position. If GPS goes stale, APB output pauses automatically.
  </div>
</div>

<div class="card">
  <h3>Last output</h3>
  <pre id="last">(none yet)</pre>
</div>

<div class="card">
  <h3>Source selection (best available)</h3>
  <pre id="sources">(loading...)</pre>
</div>

<script>
async function cmd(c, v){
  const r = await fetch('./cmd', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({c, v})
  })
  const j = await r.json()
  render(j)
}
function render(j){
  document.getElementById('en').textContent = j.enabled ? 'ON' : 'OFF'
  document.getElementById('mode').textContent = j.mode

  const st = j.status?.best || {}
  document.getElementById('hdg').textContent = st.headingMagDeg ?? '--'
  document.getElementById('cog').textContent = st.cogMagDeg ?? '--'
  document.getElementById('gpsFresh').textContent = st.positionFresh ? 'YES' : 'NO'

  document.getElementById('tgt').textContent = j.targetMagDeg ?? '--'
  document.getElementById('trkOn').textContent = j.trackActive ? 'YES' : 'NO'
  document.getElementById('trkBrg').textContent = j.trackBearingMagDeg ?? '--'
  document.getElementById('trkStart').textContent = j.trackStart ? (j.trackStart.lat.toFixed(5)+','+j.trackStart.lon.toFixed(5)) : '--'

  document.getElementById('last').textContent =
    j.lastSentence ? (j.lastSentence + "\\n" + (j.lastEmitTs ?? "")) : '(none yet)'

  document.getElementById('sources').textContent = JSON.stringify(j.status, null, 2)
}
async function poll(){
  const r = await fetch('./state')
  const j = await r.json()
  render(j)
}
poll()
setInterval(poll, 1000)
</script>
</body>
</html>`
  }

  return plugin
}
