const express = require('express')

module.exports = function (app) {
  let timer = null
  let enabled = false
  let targetMagDeg = null
  let lastSentence = null
  let lastEmitTs = null

  const plugin = {
    id: 'signalk-hts-bod',
    name: 'Heading-to-Steer (BOD)',
    description:
      'Generate NMEA0183 BOD heading-to-steer sentences from Signal K heading with Hold/+/- controls.',
    schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', title: 'Enable output', default: false },
        rateHz: {
          type: 'number',
          title: 'Output rate (Hz)',
          default: 1,
          minimum: 0.2,
          maximum: 10
        },
        talker: {
          type: 'string',
          title: 'Talker ID (2 chars)',
          default: 'II'
        },
        headingPath: {
          type: 'string',
          title: 'Heading magnetic path',
          default: 'navigation.headingMagnetic'
        },
        variationPath: {
          type: 'string',
          title: 'Magnetic variation path (optional)',
          default: 'navigation.magneticVariation'
        },
        destinationId: {
          type: 'string',
          title: 'BOD destination ID (optional)',
          default: 'DEST'
        },
        originId: {
          type: 'string',
          title: 'BOD origin ID (optional)',
          default: 'ORIG'
        }
      }
    },

    start: function (options) {
      enabled = !!options.enabled
      const rateHz = Number(options.rateHz || 1)
      const talker = sanitizeTalker(options.talker || 'II')
      const headingPath = options.headingPath || 'navigation.headingMagnetic'
      const variationPath = options.variationPath || 'navigation.magneticVariation'
      const destinationId = (options.destinationId || 'DEST').slice(0, 8)
      const originId = (options.originId || 'ORIG').slice(0, 8)

      // ---------- Web UI ----------
      const router = express.Router()

      router.get('/', (_req, res) => {
        res.type('html').send(uiHtml())
      })

      router.get('/state', (_req, res) => {
        res.json({
          enabled,
          targetMagDeg,
          currentMagDeg: getHeadingMagDeg(headingPath),
          lastSentence,
          lastEmitTs
        })
      })

      router.post('/cmd', express.json(), (req, res) => {
        const c = req.body?.c
        const v = req.body?.v

        if (c === 'enable') enabled = true
        if (c === 'disable') enabled = false
        if (c === 'clear') targetMagDeg = null

        const cur = getHeadingMagDeg(headingPath)

        if (c === 'hold' && cur != null) targetMagDeg = cur
        if (c === 'p1' && targetMagDeg != null) targetMagDeg = wrap360(targetMagDeg + 1)
        if (c === 'm1' && targetMagDeg != null) targetMagDeg = wrap360(targetMagDeg - 1)
        if (c === 'p10' && targetMagDeg != null) targetMagDeg = wrap360(targetMagDeg + 10)
        if (c === 'm10' && targetMagDeg != null) targetMagDeg = wrap360(targetMagDeg - 10)
        if (c === 'set') {
          const n = Number(v)
          if (Number.isFinite(n)) targetMagDeg = wrap360(n)
        }

        res.json({
          enabled,
          targetMagDeg,
          currentMagDeg: cur,
          lastSentence,
          lastEmitTs
        })
      })

      app.registerRouter(router, '/plugins/hts-bod')

      // ---------- Output loop ----------
      stopTimer()
      const periodMs = Math.max(100, Math.round(1000 / rateHz))

      timer = setInterval(() => {
        if (!enabled) return
        if (targetMagDeg == null) return // safety: do nothing until HOLD/SET

        // Compute true heading if variation exists
        const variationRad = getAngleRad(variationPath) // east-positive (Signal K typically)
        const targetTrueDeg =
          variationRad != null ? wrap360(targetMagDeg + radToDeg(variationRad)) : null

        const sentence = buildBOD({
          talker,
          trueDeg: targetTrueDeg,
          magDeg: targetMagDeg,
          dest: destinationId,
          orig: originId
        })

        lastSentence = sentence.trim()
        lastEmitTs = new Date().toISOString()
        app.emit('nmea0183out', sentence)
      }, periodMs)

      app.setPluginStatus('Running. UI: /plugins/hts-bod')
    },

    stop: function () {
      stopTimer()
      app.setPluginStatus('Stopped')
    }
  }

  function stopTimer() {
    if (timer) clearInterval(timer)
    timer = null
  }

  function sanitizeTalker(t) {
    const up = String(t || 'II').toUpperCase().replace(/[^A-Z0-9]/g, '')
    return (up.length >= 2 ? up.slice(0, 2) : 'II')
  }

  // Get angle (radians or degrees) from a Signal K path; return radians.
  function getAngleRad(path) {
    const v = app.getSelfPath(path)?.value
    if (v == null) return null
    const num = Number(v)
    if (!Number.isFinite(num)) return null
    // Heuristic: if small enough, assume radians; else degrees.
    return Math.abs(num) <= Math.PI * 2 + 0.5 ? num : degToRad(num)
  }

  // Heading magnetic in degrees (0..359.9)
  function getHeadingMagDeg(path) {
    const rad = getAngleRad(path)
    if (rad == null) return null
    return wrap360(radToDeg(rad))
  }

  function wrap360(deg) {
    let d = deg % 360
    if (d < 0) d += 360
    return Math.round(d * 10) / 10
  }

  const radToDeg = (r) => (r * 180) / Math.PI
  const degToRad = (d) => (d * Math.PI) / 180

  function fmtDeg(deg) {
    // NMEA often uses 3 digits + 1 decimal (e.g., 083.4)
    const d = wrap360(deg)
    const s = d.toFixed(1)
    // pad to at least 5 chars like "083.4"
    return s.padStart(5, '0')
  }

  function buildBOD({ talker, trueDeg, magDeg, dest, orig }) {
    const tField = trueDeg != null ? fmtDeg(trueDeg) : ''
    const mField = magDeg != null ? fmtDeg(magDeg) : ''
    const body = `${talker}BOD,${tField},T,${mField},M,${dest || ''},${orig || ''}`
    return addChecksum(`$${body}`)
  }

  function addChecksum(sentence) {
    let c = 0
    for (let i = 1; i < sentence.length; i++) {
      c ^= sentence.charCodeAt(i)
    }
    const hex = c.toString(16).toUpperCase().padStart(2, '0')
    return `${sentence}*${hex}\r\n`
  }

  function uiHtml() {
    return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body{font-family:system-ui;margin:16px;max-width:680px}
  button{font-size:18px;padding:10px 14px;margin:6px}
  .row{margin:10px 0}
  input{font-size:18px;padding:8px;width:110px}
  .pill{display:inline-block;padding:4px 10px;border-radius:999px;background:#eee;margin-left:8px}
  pre{background:#f6f6f6;padding:10px;border-radius:8px;overflow:auto}
</style>
</head>
<body>
<h2>Heading-to-Steer (BOD)</h2>

<div class="row">
  <span>Enabled: <span id="en" class="pill">--</span></span>
  <span>Current mag: <span id="cur" class="pill">--</span>°</span>
  <span>Target mag: <span id="tgt" class="pill">--</span>°</span>
</div>

<div class="row">
  <button onclick="cmd('hold')">HOLD</button>
  <button onclick="cmd('m1')">-1</button>
  <button onclick="cmd('p1')">+1</button>
  <button onclick="cmd('m10')">-10</button>
  <button onclick="cmd('p10')">+10</button>
</div>

<div class="row">
  <input id="setv" type="number" min="0" max="359" placeholder="Set deg" />
  <button onclick="cmd('set')">SET</button>
  <button onclick="cmd('clear')">CLEAR</button>
</div>

<div class="row">
  <button onclick="cmd('enable')">ENABLE</button>
  <button onclick="cmd('disable')">DISABLE</button>
</div>

<h3>Last output</h3>
<pre id="last">(none yet)</pre>

<script>
async function cmd(c){
  const v = document.getElementById('setv').value
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
  document.getElementById('cur').textContent = j.currentMagDeg ?? '--'
  document.getElementById('tgt').textContent = j.targetMagDeg ?? '--'
  document.getElementById('last').textContent =
    j.lastSentence ? (j.lastSentence + "\\n" + (j.lastEmitTs ?? "")) : '(none yet)'
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
