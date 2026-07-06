// renderer/swarm-visual.js
// -------------------------------------------------------------------
//  The Nexus Swarm \u2014 multi-million-dollar V2 polish.
//  Modern-minimalist 3D scene: central crystalline core, 7 orbital
//  polyhedra with iridescent + auras + trails + energy beams + sonar
//  pulse rings + cursor-damped camera parallax. HTML readouts get a
//  pulse-dot, an inline SVG sparkline (rolling-window path d), and an
//  activity bar. Constellation lines light up between the focused
//  agent and its two nearest peers.
//
//  Z-INDEX STACK (renderer/index.html):
//    canvas.orb              (3) existing 2D orchestrator main orb
//    .nexus-reticle          (2) CSS-only reticle that sits BEHIND the orb
//    .nexus-three canvas     (4) Three.js sub-agent + grid + stars + core
//    .nexus-leaders svg      (5) razor-thin leader lines to labels
//    .nexus-readouts div     (6) monospaced "holographic" readouts
//    .nexus-hud-chrome       (7) CSS-only corner brackets framing scene
//
//  DEPTH OCCLUSION via an invisible occluder sphere:
//    Anything whose world-Z is on the far side of z=+84 is pixel-culled
//    by WebGL's depth test \u2014 the 2D canvas underneath shows through.
//    The central core sits at z<0 so only its silhouette peeks around
//    the 2D orb halo on most angles.
//
//  BRIDGE: config-swarmShowOrbs hides the layer; live toggles
//  re-mount without restarting Electron. swarm:dispatch-start fires
//  fireBeacon(to) which draws an additive ribbon from origin to the
//  dispatched agent using a head-segment that scrolls along via
//  setDrawRange. The dispatched agent also gets a ~1.8s emissive pulse
//  via _pulseUntil.
//
//  ACCESSIBILITY: prefers-reduced-motion slows ring + spin axes, kills
//  HUD pulse animations, dampens pointer parallax.
// -------------------------------------------------------------------

(function () {
  // -------------------- Configuration --------------------
  // 7 unique-geometry agents. Each has a distinct primitive, a
  // neon accent colour, and a base orbit inclination. The geometry
  // builder picks the matching Three.js primitive at init time.
  const NEXUS_AGENTS = [
    { name: 'EXECUTOR',   role: 'action',     displayHertz: '8.4 Hz',  initialState: 'IDLE',     geometry: 'octahedron',   color: 0xf0b96e, cssColor: '#f0b96e', meshSize: 30, distance: 220, theta0: 0.0, phi0:  0.10, speedTheta: 0.22, speedPhi: 0.30, spin: 1.00 },
    { name: 'CODER',      role: 'synthesis',  displayHertz: '6.2 Hz',  initialState: 'READY',    geometry: 'icosahedron',  color: 0xa98bff, cssColor: '#a98bff', meshSize: 26, distance: 230, theta0: 1.0, phi0: -0.05, speedTheta: 0.27, speedPhi: 0.36, spin: 0.85 },
    { name: 'CRITIC',     role: 'validation', displayHertz: '4.1 Hz',  initialState: 'READY',    geometry: 'tetrahedron',  color: 0xff5599, cssColor: '#ff5599', meshSize: 22, distance: 250, theta0: 2.0, phi0:  0.18, speedTheta: 0.32, speedPhi: 0.42, spin: 0.95 },
    { name: 'VISION',     role: 'perception', displayHertz: '12.0 Hz', initialState: 'ACTIVE',   geometry: 'dodecahedron',color: 0x7fd1ff, cssColor: '#7fd1ff', meshSize: 19, distance: 265, theta0: 3.0, phi0: -0.12, speedTheta: 0.18, speedPhi: 0.28, spin: 0.75 },
    { name: 'RESEARCHER', role: 'inquiry',    displayHertz: '3.7 Hz',  initialState: 'READY',    geometry: 'torusKnot',    color: 0x5ad6c4, cssColor: '#5ad6c4', meshSize: 16, distance: 290, theta0: 4.0, phi0:  0.05, speedTheta: 0.14, speedPhi: 0.22, spin: 0.65 },
    { name: 'MEMORY',     role: 'recall',     displayHertz: '1.2 K/s', initialState: 'STANDBY',  geometry: 'sphere',       color: 0x5ad19a, cssColor: '#5ad19a', meshSize: 13, distance: 310, theta0: 5.0, phi0: -0.22, speedTheta: 0.10, speedPhi: 0.18, spin: 0.45 },
    { name: 'PLANNER',    role: 'strategy',   displayHertz: '5.0 Hz',  initialState: 'READY',    geometry: 'cone',         color: 0xf5b53d, cssColor: '#f5b53d', meshSize: 18, distance: 240, theta0: 5.6, phi0:  0.15, speedTheta: 0.24, speedPhi: 0.32, spin: 0.78 },
  ];

  const FOV = 52;
  const CAMERA_Z = 900;
  const RING_RADII = [108, 138, 178];
  const OCCLUDER_RADIUS = 84;
  const STAR_COUNT = 620;
  const CLEARANCE_SLOP_3D = 36;
  const MIN_ORBIT_DIST = 235;
  const TRAIL_VERTS = 40;
  const SPARK_SAMPLES = 36;

  // -------------------- Boot config --------------------
  function boot(cb) {
    const br = window.bridge;
    if (!br || typeof br.swarmConfig !== 'function') { cb(true); return; }
    Promise.resolve(br.swarmConfig()).then(function (cfg) {
      if (!cfg || cfg.ok === undefined) { cb(true); return; }
      cb(cfg.swarmShowOrbs !== false);
    }).catch(function () { cb(true); });
    if (typeof br.onSwarmEvent === 'function') {
      const off = br.onSwarmEvent(function (ev) {
        if (ev && ev.kind === 'config-changed' && ev.key === 'swarmShowOrbs') {
          if (ev.value === false && _canvasHost) {
            teardown();
          } else if (ev.value !== false && !_canvasHost) {
            initLayer();
          }
        }
      });
      if (typeof off === 'function') _swarmEventUnsubs.push(off);
    }
  }

  // -------------------- State --------------------
  let _canvasHost = null;
  let _threeCanvas = null;
  let _leadersSvg = null;
  let _readoutsContainer = null;
  let _scene = null;
  let _camera = null;
  let _renderer = null;
  let _threeReady = false;
  let _ringMeshes = [];
  let _agentRecords = [];
  let _raf = null;
  let _t0 = performance.now();
  let _pulseUntil = Object.create(null);
  let _focusedName = null;
  let _lastInteractAt = performance.now();
  let _reducedMotion = false;
  let _THREE = null;
  let _tmpVec3 = null;
  let _swarmEventUnsubs = [];
  let _windowHandlerUnsubs = [];
  const _idleThresholdMs = 2500;

  // ---- V2 feature state ----
  let _pointerTargetX = 0, _pointerTargetY = 0;
  let _pointerX = 0, _pointerY = 0;
  let _trails = [];      // [{line, geo, positions, headColor}]
  let _auras = [];       // [Mesh]
  let _beams = [];       // [{line, geo, positions, colors}]
  let _coreMesh = null, _coreWire = null, _coreInner = null;
  let _sonarRings = [];  // [{mesh, mat, startedAt, peak}]
  let _lastSonarAt = 0;
  let _constellation = null; // {line, geo, positions}
  let _sparkHistory = [[], [], [], [], [], [], []];
  let _comets = [];      // [{line, geo, mat, startedAt, durationMs, segs}]

  function _detectReducedMotion() {
    try {
      const mql = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
      _reducedMotion = !!(mql && mql.matches);
      // Honour runtime preference switches (modern browsers support
      // addEventListener on MediaQueryList; older Safari/WebKit used
      // addListener which is a no-op there).
      if (mql && mql.addEventListener) {
        const onChange = function (ev) { _reducedMotion = !!ev.matches; };
        mql.addEventListener('change', onChange);
        _windowHandlerUnsubs.push(function () { try { mql.removeEventListener('change', onChange); } catch (_e) {} });
      }
    } catch (_e) { _reducedMotion = false; }
  }

  function _mainOrbLevel() {
    if (typeof orb === 'undefined' || !orb || typeof orb.level !== 'number') return 0;
    const lv = orb.level;
    if (lv < 0) return 0;
    if (lv > 1) return 1;
    return lv;
  }

  // -------------------- DOM-mount + interaction wiring --------------------
  function initLayer() {
    if (_canvasHost) return;
    if (_reducedMotion == null) _detectReducedMotion();
    const view = document.getElementById('view-orb');
    if (!view) return;

    _canvasHost = view;
    _threeCanvas = document.getElementById('nexus-three-canvas');
    _leadersSvg = document.getElementById('nexus-leaders');
    _readoutsContainer = document.getElementById('nexus-readouts');
    if (!_threeCanvas || !_leadersSvg || !_readoutsContainer) return;

    _buildReadoutsAndLeaders();
    _wireClicks();
    initNexus();
    if (_raf == null) {
      _t0 = performance.now();
      _raf = requestAnimationFrame(_tick);
    }
  }

  function _buildReadoutsAndLeaders() {
    NEXUS_AGENTS.forEach(function (a) {
      const labelEl = document.createElement('div');
      labelEl.className = 'nexus-readout';
      labelEl.dataset.agent = a.name;
      labelEl.style.setProperty('--nx-color', a.cssColor);
      labelEl.innerHTML =
        '<div class="nx-name">' + a.name + '</div>' +
        '<div class="nx-role">' + a.role + ' \u00b7 ' + a.displayHertz + '</div>' +
        '<div class="nx-state"><span class="nx-dot"></span><span class="nx-state-text">' + a.initialState + '</span></div>' +
        '<svg class="nx-spark" viewBox="0 0 ' + SPARK_SAMPLES + ' 18" preserveAspectRatio="none"><path d=""/></svg>' +
        '<div class="nx-bar"><i></i></div>';
      labelEl._sparkPath = labelEl.querySelector('.nx-spark path');
      labelEl._barI = labelEl.querySelector('.nx-bar > i');
      labelEl._stateText = labelEl.querySelector('.nx-state-text');
      _readoutsContainer.appendChild(labelEl);

      const lineEl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      lineEl.setAttribute('stroke', a.cssColor);
      lineEl.setAttribute('stroke-width', '0.85');
      lineEl.setAttribute('stroke-opacity', '0.55');
      _leadersSvg.appendChild(lineEl);

      _agentRecords.push({
        name: a.name, data: a,
        labelEl: labelEl, leaderEl: lineEl,
        mesh: null, baseMat: null, rimMat: null,
        target: { x: 0, y: 0, z: 0 }, reach: 0,
      });
    });
  }

  function _wireClicks() {
    if (!_threeCanvas || !_threeCanvas.addEventListener) return;
    _threeCanvas.addEventListener('click', function (ev) {
      _lastInteractAt = performance.now();
      if (!_threeReady || !_THREE || !_camera) return;
      const rect = _threeCanvas.getBoundingClientRect();
      const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((ev.clientY - rect.top) / rect.height * 2 - 1);
      const ray = new _THREE.Raycaster();
      ray.setFromCamera({ x: x, y: y }, _camera);
      const meshes = _agentRecords.map(function (r) { return r.mesh; }).filter(Boolean);
      const hits = ray.intersectObjects(meshes, false);
      if (hits.length > 0) {
        const m = hits[0].object;
        if (m && m.userData && m.userData.agentName) {
          _focusedName = m.userData.agentName;
          return;
        }
      }
      _focusedName = null;
    });
    _threeCanvas.addEventListener('pointerdown', function () {
      _lastInteractAt = performance.now();
    });
    // Mouse parallax: track normalised pointer coords [-1, 1]. Stored in
    // _windowHandlerUnsubs so a config-toggle teardown drops this listener
    // instead of stacking one per mount cycle.
    const onMove = function (ev) {
      if (!_canvasHost) return;
      const w = window.innerWidth, h = window.innerHeight;
      _pointerTargetX = Math.max(-1, Math.min(1, (ev.clientX / w) * 2 - 1));
      _pointerTargetY = Math.max(-1, Math.min(1, (ev.clientY / h) * 2 - 1));
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    _windowHandlerUnsubs.push(function () { window.removeEventListener('mousemove', onMove); });
    // Resize + Esc only register while the layer is visible (mounting
    // happens inside initLayer, unmounting happens inside teardown).
    window.addEventListener('resize', _onResize);
    _windowHandlerUnsubs.push(function () { window.removeEventListener('resize', _onResize); });
    window.addEventListener('keydown', _onEscKeydown);
    _windowHandlerUnsubs.push(function () { window.removeEventListener('keydown', _onEscKeydown); });
  }

  // -------------------- Three.js async boot --------------------
  async function initNexus() {
    if (_threeReady) return;
    let T;
    try {
      const mod = await import('three');
      T = mod && (mod.default || mod);
    } catch (e) { console.warn('[nexus] three.js not loaded:', e); return; }
    if (!_canvasHost) return;
    if (!T || !T.Scene) { console.warn('[nexus] three.js load invalid:', T); return; }
    _THREE = T;
    _tmpVec3 = new _THREE.Vector3();

    _scene = new _THREE.Scene();
    _scene.background = null;
    _scene.fog = new _THREE.FogExp2(0x06070d, 0.0007);
    _camera = new _THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 5000);
    _camera.position.set(0, 0, CAMERA_Z);

    _renderer = new _THREE.WebGLRenderer({
      canvas: _threeCanvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    _renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    _renderer.setSize(window.innerWidth, window.innerHeight, false);
    _renderer.setClearColor(0x000000, 0.0);

    _buildOccluder();
    _buildRings();
    _buildAgents();
    _buildAuras();
    _buildTrails();
    _buildBeams();
    _buildStarDust();
    _buildGrid();
    _buildCore();
    _buildSonar();
    _buildConstellation();
    _buildLights();

    _threeReady = true;
    for (let h = 0; h < _sparkHistory.length; h++) _sparkHistory[h] = [];
  }

  // -------------------- Scene builders --------------------
  function _buildOccluder() {
    const occluder = new _THREE.Mesh(
      new _THREE.SphereGeometry(OCCLUDER_RADIUS, 24, 18),
      new _THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true })
    );
    occluder.position.set(0, 0, 0);
    _scene.add(occluder);
  }

  function _buildRings() {
    _ringMeshes = [];
    RING_RADII.forEach(function (r, i) {
      const ring = new _THREE.Mesh(
        new _THREE.TorusGeometry(r, 0.5, 8, 128),
        new _THREE.MeshBasicMaterial({
          color: 0xe7e9ee,
          transparent: true,
          opacity: 0.55 - i * 0.10,
          blending: _THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      if (i === 1) ring.rotation.x = Math.PI / 2;
      if (i === 2) { ring.rotation.x = Math.PI / 3; ring.rotation.y = Math.PI / 6; }
      ring.userData = { speed:  0.005 + i * 0.002,
                        speedX: 0.003 + i * 0.001 };
      _scene.add(ring);
      _ringMeshes.push(ring);
    });
  }

  function _buildAgentGeometry(key) {
    switch (key) {
      case 'octahedron':   return new _THREE.OctahedronGeometry(1.0, 0);
      case 'icosahedron':  return new _THREE.IcosahedronGeometry(1.0, 0);
      case 'tetrahedron':  return new _THREE.TetrahedronGeometry(1.20, 0);
      case 'dodecahedron': return new _THREE.DodecahedronGeometry(0.95, 0);
      case 'torusKnot':    return new _THREE.TorusKnotGeometry(0.65, 0.20, 80, 12);
      case 'sphere':       return new _THREE.SphereGeometry(1.0, 28, 18);
      case 'cone':         return new _THREE.ConeGeometry(0.85, 1.45, 8);
      default:             return new _THREE.SphereGeometry(1, 16, 12);
    }
  }

  function _buildAgents() {
    NEXUS_AGENTS.forEach(function (a) {
      const geom = _buildAgentGeometry(a.geometry);
      const baseMat = new _THREE.MeshPhysicalMaterial({
        color: a.color,
        emissive: a.color,
        emissiveIntensity: 0.40,
        roughness: 0.18,
        metalness: 0.35,
        iridescence: 1.0,
        iridescenceIOR: 1.32,
        clearcoat: 1.0,
        clearcoatRoughness: 0.10,
        transparent: true,
        opacity: 0.92,
      });
      const mesh = new _THREE.Mesh(geom, baseMat);
      mesh.scale.setScalar(a.meshSize);
      mesh.userData = { agentName: a.name };

      const rimMat = new _THREE.MeshBasicMaterial({
        color: a.color,
        side: _THREE.BackSide,
        transparent: true,
        opacity: 0.42,
        blending: _THREE.AdditiveBlending,
        depthWrite: false,
      });
      const rim = new _THREE.Mesh(geom, rimMat);
      rim.scale.setScalar(1.18);
      mesh.add(rim);

      _scene.add(mesh);

      const theta = a.theta0, phi = a.phi0, r = a.distance;
      const tx = Math.cos(theta) * Math.cos(phi) * r;
      const ty = Math.sin(phi)               * r * 0.55;
      const tz = Math.sin(theta) * Math.cos(phi) * r;
      mesh.position.set(tx, ty, tz);

      const rec = _agentRecords.find(function (x) { return x.name === a.name; });
      if (rec) {
        rec.mesh = mesh;
        rec.baseMat = baseMat;
        rec.rimMat = rimMat;
        rec.target = { x: tx, y: ty, z: tz };
        rec.reach = a.meshSize * 1.18;
      }
    });
  }

  // Aura back-face halo attached as child of each agent mesh.
  function _buildAuras() {
    _auras = [];
    NEXUS_AGENTS.forEach(function (a, idx) {
      const sphere = new _THREE.Mesh(
        new _THREE.SphereGeometry(1.0, 16, 12),
        new _THREE.MeshBasicMaterial({
          color: a.color,
          side: _THREE.BackSide,
          transparent: true,
          opacity: 0.12,
          blending: _THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      sphere.scale.setScalar(1.6);
      const rec = _agentRecords[idx];
      if (rec && rec.mesh) rec.mesh.add(sphere);
      _auras.push(sphere);
    });
  }

  // Particle trail: Line w/ BufferGeometry of TRAIL_VERTS * 3 floats.
  // Per-frame: shift tail positions back, push current position to head.
  // Build-time: pre-fill all positions to the agent's starting anchor so
  // the first frame doesn't trace a strap-line back to (0,0,0).
  function _buildTrails() {
    _trails = [];
    NEXUS_AGENTS.forEach(function (a, idx) {
      const positions = new Float32Array(TRAIL_VERTS * 3);
      const colors = new Float32Array(TRAIL_VERTS * 3);
      const geo = new _THREE.BufferGeometry();
      geo.setAttribute('position', new _THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color', new _THREE.BufferAttribute(colors, 3));
      const c = new _THREE.Color(a.color);
      for (let v = 0; v < TRAIL_VERTS; v++) {
        const fade = 1 - v / (TRAIL_VERTS - 1);
        colors[v * 3]     = c.r * fade;
        colors[v * 3 + 1] = c.g * fade;
        colors[v * 3 + 2] = c.b * fade;
      }
      // Pre-fill positions to the agent's initial orbit slot so the
      // trail's first frame already matches the agent's location. The
      // matching record exists because _buildAgents runs first.
      const initialRec = _agentRecords[idx];
      if (initialRec && initialRec.target) {
        for (let v = 0; v < TRAIL_VERTS; v++) {
          positions[v * 3]     = initialRec.target.x;
          positions[v * 3 + 1] = initialRec.target.y;
          positions[v * 3 + 2] = initialRec.target.z;
        }
      }
      const mat = new _THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
        blending: _THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new _THREE.Line(geo, mat);
      _scene.add(line);
      _trails.push({ line: line, geo: geo, positions: positions, headColor: [c.r, c.g, c.b] });
    });
  }

  // Energy beams: 7 Line objects, 2 verts each. Endpoints rewritten per frame
  // so the line follows the orbiting agent.
  function _buildBeams() {
    _beams = [];
    NEXUS_AGENTS.forEach(function (a) {
      const positions = new Float32Array(2 * 3);
      const colors = new Float32Array(2 * 3);
      const geo = new _THREE.BufferGeometry();
      geo.setAttribute('position', new _THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color', new _THREE.BufferAttribute(colors, 3));
      const mat = new _THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.12,
        blending: _THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new _THREE.Line(geo, mat);
      _scene.add(line);
      _beams.push({ line: line, geo: geo, positions: positions, colors: colors });
    });
  }

  function _buildStarDust() {
    const positions = new Float32Array(STAR_COUNT * 3);
    const sizes = new Float32Array(STAR_COUNT);
    for (let i = 0; i < STAR_COUNT; i++) {
      const r = 1400 + Math.random() * 500;
      const u = Math.random(), v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);
      positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.45;
      positions[i * 3 + 2] = r * Math.cos(phi);
      sizes[i] = 0.6 + Math.random() * 0.5;
    }
    const g = new _THREE.BufferGeometry();
    g.setAttribute('position', new _THREE.BufferAttribute(positions, 3));
    g.setAttribute('size', new _THREE.BufferAttribute(sizes, 1));
    const m = new _THREE.PointsMaterial({
      color: 0x6a8aa8,
      size: 1.4,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
    });
    _scene.add(new _THREE.Points(g, m));
  }

  function _buildGrid() {
    const grid = new _THREE.GridHelper(1800, 60, 0x1a2030, 0x141a26);
    grid.material.transparent = true;
    grid.material.opacity = 0.22;
    grid.material.depthWrite = false;
    grid.position.y = -260;
    _scene.add(grid);

    const depthRing = new _THREE.Mesh(
      new _THREE.RingGeometry(620, 624, 64),
      new _THREE.MeshBasicMaterial({
        color: 0x2a3850,
        side: _THREE.DoubleSide,
        transparent: true,
        opacity: 0.30,
        depthWrite: false,
      })
    );
    depthRing.rotation.x = Math.PI / 2;
    depthRing.position.z = -300;
    _scene.add(depthRing);
  }

  // Central crystalline core: 3-layer Octahedron + wire overlay + inner shard.
  // Sits at z<-100 so it stays BEHIND the 2D orb's halo on most angles.
  // Only silhouette tips peek around the orb's outline via WebGL depth.
  function _buildCore() {
    const coreGeom = new _THREE.OctahedronGeometry(56, 0);
    const coreMat = new _THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      emissive: 0x9fc6ff,
      emissiveIntensity: 0.45,
      roughness: 0.20,
      metalness: 0.55,
      iridescence: 1.0,
      iridescenceIOR: 1.32,
      clearcoat: 1.0,
      clearcoatRoughness: 0.10,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
      depthTest: false,
    });
    _coreMesh = new _THREE.Mesh(coreGeom, coreMat);
    _coreMesh.position.set(0, 0, -90);
    _scene.add(_coreMesh);

    _coreWire = new _THREE.Mesh(coreGeom, new _THREE.MeshBasicMaterial({
      color: 0x7fd1ff,
      wireframe: true,
      transparent: true,
      opacity: 0.30,
      depthWrite: false,
      depthTest: false,
    }));
    _coreWire.position.copy(_coreMesh.position);
    _coreWire.scale.setScalar(1.02);
    _scene.add(_coreWire);

    _coreInner = new _THREE.Mesh(
      new _THREE.OctahedronGeometry(34, 0),
      new _THREE.MeshBasicMaterial({
        color: 0xffffff,
        emissive: 0xffffff,
        transparent: true,
        opacity: 0.55,
        blending: _THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      })
    );
    _coreInner.position.set(0, 0, 0);
    _coreInner.material.emissiveIntensity = 0.6;
    _scene.add(_coreInner);
  }

  // Sonar wavefront pulse rings. 2 rings on the XZ plane, recycled every
  // ~4.4s. Scale grows eased-out to ~360; opacity fades to 0.
  function _buildSonar() {
    _sonarRings = [];
    for (let i = 0; i < 2; i++) {
      const ring = new _THREE.Mesh(
        new _THREE.TorusGeometry(1.0, 0.65, 8, 96),
        new _THREE.MeshBasicMaterial({
          color: i === 0 ? 0x7fd1ff : 0xa98bff,
          transparent: true,
          opacity: 0.0,
          blending: _THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.set(0, 0, -88);
      ring.scale.setScalar(0.001);
      _scene.add(ring);
      _sonarRings.push({ mesh: ring, mat: ring.material, startedAt: performance.now() + i * 880, peak: 0.55 });
    }
  }

  // Constellation LineSegments (2 stubs, 3 verts each).
  function _buildConstellation() {
    const positions = new Float32Array(6);
    const geo = new _THREE.BufferGeometry();
    geo.setAttribute('position', new _THREE.BufferAttribute(positions, 3));
    geo.setDrawRange(0, 6);
    const mat = new _THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      blending: _THREE.AdditiveBlending,
      depthWrite: false,
    });
    const line = new _THREE.LineSegments(geo, mat);
    line.visible = false;
    _scene.add(line);
    _constellation = { line: line, geo: geo, positions: positions };
  }

  function _buildLights() {
    const cyan = new _THREE.PointLight(0x7fd1ff, 1.6, 1500, 1.6);
    cyan.position.set(280, 180, 220);
    _scene.add(cyan);
    const magenta = new _THREE.PointLight(0xff5599, 1.2, 1500, 1.6);
    magenta.position.set(-340, -180, 100);
    _scene.add(magenta);
    const amber = new _THREE.PointLight(0xf5b53d, 0.9, 1500, 1.6);
    amber.position.set(50, -240, -180);
    _scene.add(amber);
    _scene.add(new _THREE.AmbientLight(0x1c2230, 0.32));
  }

  // -------------------- Per-frame loop (V2) --------------------
  function _tick(t) {
    _raf = requestAnimationFrame(_tick);
    if (!_threeReady || !_renderer || !_scene || !_camera) return;

    const elapsed = (t - _t0) / 1000;
    const now = performance.now();
    const mainLevel = _mainOrbLevel();
    const idleNow = (now - _lastInteractAt) > _idleThresholdMs;
    const motionScale = _reducedMotion ? 0.25 : 1.0;

    // Camera parallax: damped pointer-driven offset. CAMERA_Z is preserved
    // so existing depth occlusion math (OCCLUDER_RADIUS) stays valid.
    _pointerX += (_pointerTargetX - _pointerX) * 0.05;
    _pointerY += (_pointerTargetY - _pointerY) * 0.05;
    _camera.position.x = _pointerX * 22;
    _camera.position.y = -_pointerY * 18;
    _camera.lookAt(0, 0, 0);

    // Rings: spin on multiple axes.
    _ringMeshes.forEach(function (r, i) {
      r.rotation.x += (r.userData.speedX + i * 0.0015) * motionScale;
      r.rotation.z += (r.userData.speed  + i * 0.0010) * motionScale;
    });

    // Central core pulse: scale + emissive intensity.
    if (_coreMesh) {
      _coreMesh.rotation.y += 0.0028 * motionScale;
      _coreMesh.rotation.x += 0.0010 * motionScale;
      const lv = mainLevel;
      _coreMesh.material.emissiveIntensity = 0.35 + lv * 0.55;
      const s = 1.0 + Math.sin(elapsed * 1.1) * 0.025 + lv * 0.10;
      _coreMesh.scale.setScalar(s);
      if (_coreInner) {
        _coreInner.rotation.y -= 0.0060 * motionScale;
        _coreInner.rotation.z += 0.0040 * motionScale;
        _coreInner.material.emissiveIntensity = 0.55 + lv * 0.65;
      }
      if (_coreWire) _coreWire.rotation.y -= 0.0014 * motionScale;
    }

    // Sonar rings: recycle every ~4.4s; expand + fade between cycles.
    if (_sonarRings.length && (now - _lastSonarAt) > 4400) {
      for (let s = 0; s < _sonarRings.length; s++) {
        const r = _sonarRings[s];
        if (now - r.startedAt > 1700) {
          r.startedAt = now;
          r.mesh.scale.setScalar(0.001);
          r.mesh.material.opacity = r.peak;
        }
      }
      _lastSonarAt = now;
    }
    _sonarRings.forEach(function (r) {
      const age = now - r.startedAt;
      if (age < 0) return;
      const k = Math.min(age / 1700, 1);
      const eased = 1 - Math.pow(1 - k, 2.2);
      const scale = 0.6 + eased * 360;
      r.mesh.scale.setScalar(scale);
      r.mesh.material.opacity = (1 - eased) * r.peak * (0.6 + mainLevel * 0.4);
    });

    // Per-agent orbit + auto-repel + material/depth update.
    for (let i = 0; i < _agentRecords.length; i++) {
      const recI = _agentRecords[i];
      const a = recI.data;
      const focusActive = (_focusedName === a.name);
      const theta = a.theta0 + elapsed * a.speedTheta;
      const phi   = a.phi0 + Math.sin(elapsed * a.speedPhi) * 0.40;
      const r     = a.distance;
      recI.target.x = Math.cos(theta) * Math.cos(phi) * r;
      recI.target.y = Math.sin(phi)               * r * 0.55;
      if (focusActive) {
        recI.target.z = (OCCLUDER_RADIUS + recI.reach + 8) + Math.sin(elapsed * 0.6) * 14;
      } else {
        recI.target.z = Math.sin(theta) * Math.cos(phi) * r;
        const tLen = Math.sqrt(recI.target.x * recI.target.x + recI.target.y * recI.target.y + recI.target.z * recI.target.z);
        if (tLen < MIN_ORBIT_DIST && tLen > 0.001) {
          const f = MIN_ORBIT_DIST / tLen;
          recI.target.x *= f;
          recI.target.y *= f;
          recI.target.z *= f;
        }
      }

      let dx = 0, dy = 0, dz = 0;
      for (let j = 0; j < _agentRecords.length; j++) {
        if (i === j) continue;
        const recJ = _agentRecords[j];
        const px = recI.mesh.position.x - recJ.mesh.position.x;
        const py = recI.mesh.position.y - recJ.mesh.position.y;
        const pz = recI.mesh.position.z - recJ.mesh.position.z;
        const h = Math.max(0.001, Math.sqrt(px * px + py * py + pz * pz));
        const minDist = recI.reach + recJ.reach + CLEARANCE_SLOP_3D;
        if (h < minDist) {
          const push = (minDist - h) * 0.025;
          dx += (px / h) * push;
          dy += (py / h) * push;
          dz += (pz / h) * push;
        }
      }
      recI.mesh.position.set(
        recI.mesh.position.x + (recI.target.x - recI.mesh.position.x) * 0.06 + dx,
        recI.mesh.position.y + (recI.target.y - recI.mesh.position.y) * 0.06 + dy,
        recI.mesh.position.z + (recI.target.z - recI.mesh.position.z) * 0.06 + dz
      );

      recI.mesh.rotation.x += 0.005 * a.spin * motionScale;
      recI.mesh.rotation.y += 0.007 * a.spin * motionScale;

      // Reactivity k: dispatch flame > orchestrator mirror.
      if (_pulseUntil[a.name] && now >= _pulseUntil[a.name]) delete _pulseUntil[a.name];
      const dispatchK = _pulseUntil[a.name] ? 1.0 : 0.0;
      let k;
      if (_focusedName === a.name) k = Math.max(dispatchK, mainLevel);
      else if (_focusedName) k = dispatchK;
      else if (idleNow) k = dispatchK;
      else k = Math.max(dispatchK, mainLevel);

      // Depth cue: keep the front-of-core glass treatment.
      const z = recI.mesh.position.z;
      const isFront = z > 0;
      const frontFactor = isFront ? Math.min(z / 220, 1) : 0;
      recI.baseMat.opacity = isFront ? (0.30 + 0.30 * (1 - frontFactor)) : 0.92;
      recI.baseMat.emissiveIntensity = (isFront ? 0.15 : 0.40) + k * 0.40;
      recI.rimMat.opacity = (isFront ? 0.18 : 0.42) + k * 0.20;

      // Aura back-face halo: brighten on focus + dispatch.
      const aura = _auras[i];
      if (aura) {
        const baseA = isFront ? 0.05 : 0.12;
        aura.material.opacity = baseA + (focusActive ? 0.22 : 0) + dispatchK * 0.30;
        aura.scale.setScalar(1.6 + k * 0.45 + focusActive * 0.20);
      }

      // Energy beam: line endpoint at agent position; brightness reacts.
      const beam = _beams[i];
      if (beam) {
        const bp = beam.positions;
        bp[0] = recI.mesh.position.x;
        bp[1] = recI.mesh.position.y;
        bp[2] = recI.mesh.position.z;
        bp[3] = 0; bp[4] = 0; bp[5] = 0;
        const c = recI.data.color >>> 0;
        const cr = ((c >> 16) & 0xff) / 255;
        const cg = ((c >> 8)  & 0xff) / 255;
        const cb = (c         & 0xff) / 255;
        beam.colors[0] = cr; beam.colors[1] = cg; beam.colors[2] = cb;
        beam.colors[3] = 0;  beam.colors[4] = 0;  beam.colors[5] = 0;
        const baseB = 0.05 + (focusActive ? 0.35 : 0);
        beam.line.material.opacity = baseB + dispatchK * 0.45 + (isFront ? 0.05 : 0.10);
        beam.geo.attributes.position.needsUpdate = true;
        beam.geo.attributes.color.needsUpdate = true;
      }

      // Trail: shift old samples toward tail, prepend current position.
      const trail = _trails[i];
      if (trail) {
        const arr = trail.positions;
        for (let v = (TRAIL_VERTS - 1) * 3; v >= 3; v -= 3) {
          arr[v]     = arr[v - 3];
          arr[v + 1] = arr[v - 2];
          arr[v + 2] = arr[v - 1];
        }
        arr[0] = recI.mesh.position.x;
        arr[1] = recI.mesh.position.y;
        arr[2] = recI.mesh.position.z;
        trail.geo.attributes.position.needsUpdate = true;
        // trail line opacity reacts to dispatch/focus; vertex colours
        // stay on the bake-time fade gradient (already set in _buildTrails).
        trail.line.material.opacity = 0.55 + dispatchK * 0.35 + (focusActive ? 0.15 : 0);
      }

      // Sparkline + activity bar (DOM). Reads recent rolling samples.
      const sample = Math.min(1, k + mainLevel * 0.6 + Math.abs(Math.sin(elapsed * (1.3 + i * 0.4))) * 0.3);
      const hist = _sparkHistory[i];
      hist.push(sample);
      if (hist.length > SPARK_SAMPLES) hist.shift();
      if (recI.labelEl._sparkPath && hist.length >= 2) {
        let d = '';
        const span = SPARK_SAMPLES - 1;
        for (let k2 = 0; k2 < hist.length; k2++) {
          const x = ((SPARK_SAMPLES - hist.length + k2) / span) * SPARK_SAMPLES;
          const y = 17 - hist[k2] * 15;
          d += (k2 === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
        }
        recI.labelEl._sparkPath.setAttribute('d', d.trim());
      }
      if (recI.labelEl._barI) {
        recI.labelEl._barI.style.width = (sample * 100).toFixed(0) + '%';
      }
    }

    // Constellation lines: focused -> 2 nearest peers.
    if (_constellation && _focusedName) {
      const focused = _agentRecords.find(function (r) { return r.name === _focusedName; });
      if (focused) {
        const others = _agentRecords
          .map(function (r) { return { r: r, d: r.mesh.position.distanceTo(focused.mesh.position) }; })
          .filter(function (x) { return x.r !== focused; })
          .sort(function (a, b) { return a.d - b.d; })
          .slice(0, 2);
        const arr = _constellation.positions;
        let idx = 0;
        others.forEach(function (x) {
          arr[idx++] = focused.mesh.position.x;
          arr[idx++] = focused.mesh.position.y;
          arr[idx++] = focused.mesh.position.z;
          arr[idx++] = x.r.mesh.position.x;
          arr[idx++] = x.r.mesh.position.y;
          arr[idx++] = x.r.mesh.position.z;
        });
        while (idx < 6) { arr[idx++] = focused.mesh.position.x; arr[idx++] = focused.mesh.position.y; arr[idx++] = focused.mesh.position.z; }
        _constellation.geo.attributes.position.needsUpdate = true;
        _constellation.line.material.opacity = 0.55;
        _constellation.line.visible = true;
      } else {
        _constellation.line.visible = false;
      }
    } else if (_constellation) {
      _constellation.line.visible = false;
    }

    // Project each agent -> screen for HTML readout transforms.
    _agentRecords.forEach(function (rec) {
      rec.mesh.getWorldPosition(_tmpVec3);
      _tmpVec3.project(_camera);
      const sx = ( _tmpVec3.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-_tmpVec3.y * 0.5 + 0.5) * window.innerHeight;
      const behindCore = rec.mesh.position.z < -(OCCLUDER_RADIUS + rec.reach + 6);
      const offscreen = behindCore || _tmpVec3.z > 1.0;
      if (offscreen) {
        rec.leaderEl.setAttribute('stroke-opacity', '0');
        rec.labelEl.style.opacity = '0';
        return;
      }
      rec.leaderEl.setAttribute('stroke-opacity', '0.55');
      rec.labelEl.style.opacity = '';
      const offX = rec.data.geometry === 'torusKnot' ? 38 : 32;
      const labelX = Math.max(8, Math.min(window.innerWidth - 192, sx + offX));
      const labelY = Math.max(8, Math.min(window.innerHeight - 100, sy - 18));
      rec.labelEl.style.transform = 'translate3d(' + labelX + 'px,' + labelY + 'px,0)';
      rec.leaderEl.setAttribute('x1', sx.toFixed(1));
      rec.leaderEl.setAttribute('y1', sy.toFixed(1));
      rec.leaderEl.setAttribute('x2', (labelX - 2).toFixed(1));
      rec.leaderEl.setAttribute('y2', (labelY + 14).toFixed(1));
    });

    // Readout idle / focus / dim classes.
    _agentRecords.forEach(function (rec) {
      const el = rec.labelEl;
      el.classList.remove('idle', 'dim', 'focused');
      if (_focusedName) {
        if (rec.name === _focusedName) el.classList.add('focused');
        else el.classList.add('dim');
      } else if (idleNow) {
        el.classList.add('idle');
      }
    });

    _tickComets(now);
    _renderer.render(_scene, _camera);
  }

  // -------------------- Dispatch beacon (V2 ribbon) --------------------
  // Stylized single Line drawn from origin to the dispatched agent: a
  // short luminous segment sweeps outward using setDrawRange. The target
  // also gets a ~1.8s emissive intensity pulse via _pulseUntil.
  function fireBeacon(toName) {
    if (!_threeReady || !_THREE || !_scene) return;
    const rec = _agentRecords.find(function (r) { return r.name === toName; });
    if (!rec || !rec.mesh) return;
    const segs = 56;
    const positions = new Float32Array((segs + 1) * 3);
    const colors = new Float32Array((segs + 1) * 3);
    const baseCol = new _THREE.Color(rec.data.color);
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const eased = t * t * (3 - 2 * t); // smoothstep for ribbon tail arc.
      const ax = rec.mesh.position.x * eased;
      const ay = rec.mesh.position.y * eased + Math.sin(t * Math.PI) * 36;
      const az = rec.mesh.position.z * eased + Math.sin(t * Math.PI) * 18;
      positions[s * 3]     = ax;
      positions[s * 3 + 1] = ay;
      positions[s * 3 + 2] = az;
      const head = Math.pow(1 - t, 1.6);
      colors[s * 3]     = baseCol.r * head;
      colors[s * 3 + 1] = baseCol.g * head;
      colors[s * 3 + 2] = baseCol.b * head;
    }
    const geo = new _THREE.BufferGeometry();
    geo.setAttribute('position', new _THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new _THREE.BufferAttribute(colors, 3));
    const mat = new _THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: _THREE.AdditiveBlending,
      depthWrite: false,
    });
    const line = new _THREE.Line(geo, mat);
    _scene.add(line);
    _comets.push({ line: line, geo: geo, mat: mat, startedAt: performance.now(), durationMs: 1300, segs: segs });
    _pulseUntil[toName] = performance.now() + 1800;
  }

  function _tickComets(now) {
    for (let i = _comets.length - 1; i >= 0; i--) {
      const c = _comets[i];
      const age = now - c.startedAt;
      const t = Math.min(1.0, age / c.durationMs);
      // A short luminous head slides forward via setDrawRange.
      const headWidth = 14;
      const drawCount = Math.round((t * c.segs) + headWidth);
      c.line.geometry.setDrawRange(Math.max(0, drawCount - headWidth), Math.min(c.segs + 1, drawCount));
      c.mat.opacity = Math.max(0, (1 - t) * 0.95);
      if (age > c.durationMs + 400) {
        try { if (c.line.parent) c.line.parent.removeChild(c.line); } catch (_e) {}
        try { c.geo.dispose(); c.mat.dispose(); } catch (_e) {}
        _comets.splice(i, 1);
      }
    }
  }

  // -------------------- Resize --------------------
  let _resizeTimer = null;
  // Same deferral as _onEscKeydown: the listener body and teardown are
  // defined here, but install happens inside _wireClicks so they only
  // run while the swarm layer is visible.
  function _onResize() {
    if (!_canvasHost) return;
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(function () {
      if (_camera && _renderer) {
        _camera.aspect = window.innerWidth / window.innerHeight;
        _camera.updateProjectionMatrix();
        _renderer.setSize(window.innerWidth, window.innerHeight, false);
      }
    }, 200);
  }

  // -------------------- Escape clears focus --------------------
  // Helper kept module-scope so _wireClicks can attach the listener only
  // when the swarm layer is actually visible (avoids idle listeners when
  // swarmShowOrbs is false from first paint).
  function _onEscKeydown(ev) {
    if (ev && ev.key === 'Escape' && _focusedName && _canvasHost) {
      _focusedName = null;
      _lastInteractAt = performance.now();
    }
  }

  // -------------------- Teardown --------------------
  function teardown() {
    try { if (_raf != null) cancelAnimationFrame(_raf); } catch (_e) {}
    _raf = null;
    if (_swarmEventUnsubs.length) {
      _swarmEventUnsubs.forEach(function (fn) { try { fn(); } catch (_e) {} });
      _swarmEventUnsubs = [];
    }
    if (_windowHandlerUnsubs.length) {
      _windowHandlerUnsubs.forEach(function (fn) { try { fn(); } catch (_e) {} });
      _windowHandlerUnsubs = [];
    }
    if (_scene) {
      _scene.traverse(function (obj) {
        try { if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose(); } catch (_e) {}
        try {
          if (obj.material) {
            if (Array.isArray(obj.material)) obj.material.forEach(function (m) { try { m.dispose(); } catch (_e) {} });
            else if (obj.material.dispose) obj.material.dispose();
          }
        } catch (_e) {}
      });
    }
    if (_renderer) { try { _renderer.dispose(); } catch (_e) {} _renderer = null; }
    _threeReady = false;
    _scene = null;
    _camera = null;
    _ringMeshes = [];
    if (_comets) {
      _comets.forEach(function (c) { try { if (c.line.parent) c.line.parent.removeChild(c.line); c.geo.dispose(); c.mat.dispose(); } catch (_e) {} });
      _comets = [];
    }
    if (_trails) {
      _trails.forEach(function (t) { try { if (t.line.parent) t.line.parent.removeChild(t.line); t.geo.dispose(); t.line.material.dispose(); } catch (_e) {} });
      _trails = [];
    }
    _auras = [];
    _beams = [];
    _coreMesh = null; _coreWire = null; _coreInner = null;
    _sonarRings = [];
    _constellation = null;
    _sparkHistory = [[], [], [], [], [], [], []];
    _pointerX = 0; _pointerY = 0; _pointerTargetX = 0; _pointerTargetY = 0;
    if (_readoutsContainer) {
      while (_readoutsContainer.firstChild) _readoutsContainer.removeChild(_readoutsContainer.firstChild);
    }
    if (_leadersSvg) {
      while (_leadersSvg.firstChild) _leadersSvg.removeChild(_leadersSvg.firstChild);
    }
    _agentRecords = [];
    _focusedName = null;
  }

  // -------------------- Bootstrap --------------------
  if (typeof window === 'undefined') return;
  if (!window.bridge) {
    initLayer();
  } else {
    boot(function (show) { if (show) initLayer(); });
  }
})();
