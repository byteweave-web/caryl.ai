// renderer/swarm-visual.js
// -------------------------------------------------------------------
//  The Nexus Swarm \u2014 V4 wide-cluster composition (telephoto FOV + camera pullback + key light + drift).
//
//  One 3D crystalline core + 7 orbiting polyhedra + single data ring +
//  single sonar pulse ring + sparse star dust. The 2D orchestrator orb
//  stays the dominant focal element; this overlay just frames it.
//
//  Z-INDEX STACK (renderer/index.html):
//    canvas.orb              (3) existing 2D orchestrator main orb
//    .nexus-three canvas     (4) Three.js sub-agent + ring + stars + core
//    .nexus-leaders svg      (5) leader lines to labels
//    .nexus-readouts div     (6) monospaced "holographic" readouts
//
//  DEPTH OCCLUSION via an invisible occluder sphere: anything whose
//  world-Z is on the far side of z=+100 is pixel-culled so the 2D canvas
//  shows through. The central core sits at z<-100 with depthTest off so
//  it composites over the 2D halo without being depth-culled.
//
//  BRIDGE: config-swarmShowOrbs hides the layer; live toggles
//  re-mount without restarting Electron. swarm:dispatch-start fires
//  fireBeacon(to) which draws a single Line ribbon from origin to the
//  dispatched agent using setDrawRange to slide a head segment outward.
//
//  ACCESSIBILITY: prefers-reduced-motion slows ring + camera parallax
//  via a live MediaQueryList subscription (installed from _wireClicks
//  so it's only bound while the layer is visible).
// -------------------------------------------------------------------

(function () {
  // -------------------- Configuration --------------------
  const NEXUS_AGENTS = [
    { name: 'EXECUTOR',   role: 'action',     displayHertz: '8.4 Hz',  initialState: 'IDLE',     geometry: 'octahedron',   color: 0xf0b96e, cssColor: '#f0b96e', meshSize: 28, distance: 280, theta0: 0.0, phi0:  0.10, speedTheta: 0.22, speedPhi: 0.30, spin: 1.00 },
    { name: 'CODER',      role: 'synthesis',  displayHertz: '6.2 Hz',  initialState: 'READY',    geometry: 'icosahedron',  color: 0xa98bff, cssColor: '#a98bff', meshSize: 24, distance: 320, theta0: 1.0, phi0: -0.05, speedTheta: 0.27, speedPhi: 0.36, spin: 0.85 },
    { name: 'CRITIC',     role: 'validation', displayHertz: '4.1 Hz',  initialState: 'READY',    geometry: 'tetrahedron',  color: 0xff5599, cssColor: '#ff5599', meshSize: 21, distance: 380, theta0: 2.0, phi0:  0.18, speedTheta: 0.32, speedPhi: 0.42, spin: 0.95 },
    { name: 'VISION',     role: 'perception', displayHertz: '12.0 Hz', initialState: 'ACTIVE',   geometry: 'dodecahedron', color: 0x7fd1ff, cssColor: '#7fd1ff', meshSize: 18, distance: 440, theta0: 3.0, phi0: -0.12, speedTheta: 0.18, speedPhi: 0.28, spin: 0.75 },
    { name: 'RESEARCHER', role: 'inquiry',    displayHertz: '3.7 Hz',  initialState: 'READY',    geometry: 'torusKnot',    color: 0x5ad6c4, cssColor: '#5ad6c4', meshSize: 15, distance: 510, theta0: 4.0, phi0:  0.05, speedTheta: 0.14, speedPhi: 0.22, spin: 0.65 },
    { name: 'MEMORY',     role: 'recall',     displayHertz: '1.2 K/s', initialState: 'STANDBY',  geometry: 'sphere',       color: 0x5ad19a, cssColor: '#5ad19a', meshSize: 12, distance: 580, theta0: 5.0, phi0: -0.22, speedTheta: 0.10, speedPhi: 0.18, spin: 0.45 },
    { name: 'PLANNER',    role: 'strategy',   displayHertz: '5.0 Hz',  initialState: 'READY',    geometry: 'cone',         color: 0xf5b53d, cssColor: '#f5b53d', meshSize: 17, distance: 300, theta0: 5.6, phi0:  0.15, speedTheta: 0.24, speedPhi: 0.32, spin: 0.78 },
  ];

  // V4: telephoto FOV compresses depth and pulls the cluster into a tighter
  // visual pyramid. CAMERA_Z pulled back so the wider orbital spread still
  // fits in frame, OCCLUDER_RADIUS grown proportionally so the depth-cull
  // screen ratio is preserved.
  const FOV = 46;
  const CAMERA_Z = 1100;
  const OCCLUDER_RADIUS = 100;
  const CLEARANCE_SLOP_3D = 42;
  const MIN_ORBIT_DIST = 260;
  const STAR_COUNT = 220;
  // Data ring drift slowed because the ring is now wider; reads as gentle drift.
  const DATA_RING_SPEED_X = 0.0026;
  const DATA_RING_SPEED_Y = 0.0013;

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

  // Cursor parallax (small magnitude so the scene doesn't feel like a 3D
  // viewport \u2014 just a hint of life).
  let _pointerTargetX = 0, _pointerTargetY = 0;
  let _pointerX = 0, _pointerY = 0;

  // Minimal scene state.
  let _coreMesh = null;
  let _sonarRing = null;
  let _dataRing = null;
  let _comets = [];
  let _starMesh = null;

  function _detectReducedMotion() {
    try {
      const mql = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
      _reducedMotion = !!(mql && mql.matches);
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
    // Minimal readout: name + role + state pill with a pulse dot. No
    // sparkline / no activity bar / no accent underline \u2014 just a tight
    // text block with a single colored accent that matches the agent.
    NEXUS_AGENTS.forEach(function (a) {
      const labelEl = document.createElement('div');
      labelEl.className = 'nexus-readout';
      labelEl.dataset.agent = a.name;
      labelEl.style.setProperty('--nx-color', a.cssColor);
      labelEl.innerHTML =
        '<div class="nx-name">' + a.name + '</div>' +
        '<div class="nx-row"><span class="nx-dot"></span><span class="nx-state-text">' + a.initialState + '</span><span class="nx-role">' + a.role + ' \u00b7 ' + a.displayHertz + '</span></div>';
      _readoutsContainer.appendChild(labelEl);

      const lineEl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      lineEl.setAttribute('stroke', a.cssColor);
      lineEl.setAttribute('stroke-width', '0.7');
      lineEl.setAttribute('stroke-opacity', '0.42');
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

    // Cursor parallax (very small magnitude).
    const onMove = function (ev) {
      if (!_canvasHost) return;
      const w = window.innerWidth, h = window.innerHeight;
      _pointerTargetX = Math.max(-1, Math.min(1, (ev.clientX / w) * 2 - 1));
      _pointerTargetY = Math.max(-1, Math.min(1, (ev.clientY / h) * 2 - 1));
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    _windowHandlerUnsubs.push(function () { window.removeEventListener('mousemove', onMove); });
    // Resize + Esc only register while the layer is visible.
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
    _scene.fog = new _THREE.FogExp2(0x06070d, 0.0006);
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
    _buildRing();
    _buildAgents();
    _buildStarDust();
    _buildCore();
    _buildSonar();
    _buildLights();

    _threeReady = true;
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

  // Single thin data ring; tilted so it reads as an "orbit line" without
  // being symmetric with the 2D orb axis.
  function _buildRing() {
    const ring = new _THREE.Mesh(
      new _THREE.TorusGeometry(220, 0.4, 6, 128),
      new _THREE.MeshBasicMaterial({
        color: 0xe7e9ee,
        transparent: true,
        opacity: 0.28,
        blending: _THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    ring.rotation.x = Math.PI / 2.4;
    ring.rotation.y = Math.PI / 8;
    ring.userData = { speedX: DATA_RING_SPEED_X, speedY: DATA_RING_SPEED_Y };
    _scene.add(ring);
    _dataRing = ring;
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
        emissiveIntensity: 0.32,
        roughness: 0.20,
        metalness: 0.40,
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
        opacity: 0.32,
        blending: _THREE.AdditiveBlending,
        depthWrite: false,
      });
      const rim = new _THREE.Mesh(geom, rimMat);
      rim.scale.setScalar(1.16);
      mesh.add(rim);

      _scene.add(mesh);

      const theta = a.theta0, phi = a.phi0, r = a.distance;
      const tx = Math.cos(theta) * Math.cos(phi) * r;
      const ty = Math.sin(phi)               * r * 0.78;
      const tz = Math.sin(theta) * Math.cos(phi) * r;
      mesh.position.set(tx, ty, tz);

      const rec = _agentRecords.find(function (x) { return x.name === a.name; });
      if (rec) {
        rec.mesh = mesh;
        rec.baseMat = baseMat;
        rec.rimMat = rimMat;
        rec.target = { x: tx, y: ty, z: tz };
        rec.reach = a.meshSize * 1.16;
      }
    });
  }

  function _buildStarDust() {
    const positions = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const r = 1400 + Math.random() * 500;
      const u = Math.random(), v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);
      positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.45;
      positions[i * 3 + 2] = r * Math.cos(phi);
    }
    const g = new _THREE.BufferGeometry();
    g.setAttribute('position', new _THREE.BufferAttribute(positions, 3));
    const m = new _THREE.PointsMaterial({
      color: 0x6a8aa8,
      size: 1.2,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    });
    _starMesh = new _THREE.Points(g, m);
    _scene.add(_starMesh);
  }

  // Small crystalline core. depthTest off so it composites over the 2D
  // halo without being culled by the occluder sphere.
  function _buildCore() {
    const coreGeom = new _THREE.OctahedronGeometry(34, 0);
    const coreMat = new _THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      emissive: 0xa9c8ff,
      emissiveIntensity: 0.30,
      roughness: 0.22,
      metalness: 0.50,
      iridescence: 1.0,
      iridescenceIOR: 1.32,
      clearcoat: 1.0,
      clearcoatRoughness: 0.12,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      depthTest: false,
    });
    _coreMesh = new _THREE.Mesh(coreGeom, coreMat);
    _coreMesh.position.set(0, 0, -100);
    _scene.add(_coreMesh);
  }

  // One sonar pulse ring; recycles every ~6s.
  function _buildSonar() {
    _sonarRing = new _THREE.Mesh(
      new _THREE.TorusGeometry(1.0, 0.5, 6, 96),
      new _THREE.MeshBasicMaterial({
        color: 0x7fd1ff,
        transparent: true,
        opacity: 0.0,
        blending: _THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    _sonarRing.rotation.x = Math.PI / 2;
    _sonarRing.position.set(0, 0, -98);
    _sonarRing.scale.setScalar(0.001);
    _sonarRing.userData = { startedAt: performance.now() };
    _scene.add(_sonarRing);
  }

  function _buildLights() {
    const cyan = new _THREE.PointLight(0x7fd1ff, 1.4, 1500, 1.6);
    cyan.position.set(280, 180, 220);
    _scene.add(cyan);
    const magenta = new _THREE.PointLight(0xff5599, 1.0, 1500, 1.6);
    magenta.position.set(-340, -180, 100);
    _scene.add(magenta);
    const amber = new _THREE.PointLight(0xf5b53d, 0.7, 1500, 1.6);
    amber.position.set(50, -240, -180);
    _scene.add(amber);
    // V4 KEY LIGHT: a downward DirectionalLight so MeshPhysicalMaterial's
    // iridescence + metalness get a top-facet hot edge. Without this the
    // agents looked like flat circular discs; with it they read as faceted
    // jewel forms orbiting the orb.
    const key = new _THREE.DirectionalLight(0xfff8e0, 0.45);
    key.position.set(0, 400, 200);
    _scene.add(key);
    _scene.add(new _THREE.AmbientLight(0x1c2230, 0.18));
  }

  // -------------------- Per-frame loop --------------------
  function _tick(t) {
    _raf = requestAnimationFrame(_tick);
    if (!_threeReady || !_renderer || !_scene || !_camera) return;

    const elapsed = (t - _t0) / 1000;
    const now = performance.now();
    const mainLevel = _mainOrbLevel();
    const idleNow = (now - _lastInteractAt) > _idleThresholdMs;
    const motionScale = _reducedMotion ? 0.25 : 1.0;

    // Subtle cursor parallax (kept small so the scene doesn't feel like
    // a 3D viewport).
    // Background star field yaw (parallax reference for the whole frame).
    if (_starMesh) { _starMesh.rotation.y += 0.0003 * motionScale; }

    _pointerX += (_pointerTargetX - _pointerX) * 0.05;
    _pointerY += (_pointerTargetY - _pointerY) * 0.05;
    _camera.position.x = _pointerX * 9;
    _camera.position.y = -_pointerY * 7;
    _camera.lookAt(0, 0, 0);

    // Single data ring.
    if (_dataRing) {
      _dataRing.rotation.x += _dataRing.userData.speedX * motionScale;
      _dataRing.rotation.y += _dataRing.userData.speedY * motionScale;
    }

    // Core pulse: subtle scale + emissive tied to orchestrator level.
    if (_coreMesh) {
      _coreMesh.rotation.y += 0.0025 * motionScale;
      _coreMesh.rotation.x += 0.0010 * motionScale;
      const lv = mainLevel;
      _coreMesh.material.emissiveIntensity = 0.22 + lv * 0.55;
      const s = 1.0 + Math.sin(elapsed * 0.9) * 0.020 + lv * 0.06;
      _coreMesh.scale.setScalar(s);
    }

    // Sonar pulse ring: recycle every ~6s.
    if (_sonarRing) {
      const age = now - _sonarRing.userData.startedAt;
      const cycleMs = 6000;
      const expandMs = 2000;
      if (age > cycleMs) {
        _sonarRing.userData.startedAt = now;
        _sonarRing.scale.setScalar(0.001);
        _sonarRing.material.opacity = 0.18;
      } else if (age < expandMs) {
        const k = age / expandMs;
        const eased = 1 - Math.pow(1 - k, 2.2);
        _sonarRing.scale.setScalar(0.6 + eased * 280);
        _sonarRing.material.opacity = (1 - eased) * 0.18 * (0.6 + mainLevel * 0.4);
      }
    }

    // Per-agent orbit + auto-repel + material/depth update.
    for (let i = 0; i < _agentRecords.length; i++) {
      const recI = _agentRecords[i];
      const a = recI.data;
      const focusActive = (_focusedName === a.name);
      const theta = a.theta0 + elapsed * a.speedTheta;
      const phi   = a.phi0 + Math.sin(elapsed * a.speedPhi + a.theta0 * 1.7) * 0.85;
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

      // Prune stale dispatch pulses; emit dispersion factor for materials.
      if (_pulseUntil[a.name] && now >= _pulseUntil[a.name]) delete _pulseUntil[a.name];
      const dispatchK = _pulseUntil[a.name] ? 1.0 : 0.0;
      let k;
      if (_focusedName === a.name) k = Math.max(dispatchK, mainLevel);
      else if (_focusedName) k = dispatchK;
      else if (idleNow) k = dispatchK;
      else k = Math.max(dispatchK, mainLevel);

      const z = recI.mesh.position.z;
      const isFront = z > 0;
      const frontFactor = isFront ? Math.min(z / 220, 1) : 0;
      recI.baseMat.opacity = isFront ? (0.32 + 0.30 * (1 - frontFactor)) : 0.92;
      recI.baseMat.emissiveIntensity = (isFront ? 0.15 : 0.32) + k * 0.40;
      recI.rimMat.opacity = (isFront ? 0.14 : 0.32) + k * 0.20;
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
      rec.leaderEl.setAttribute('stroke-opacity', '0.42');
      rec.labelEl.style.opacity = '';
      const offX = rec.data.geometry === 'torusKnot' ? 30 : 24;
      const labelX = Math.max(8, Math.min(window.innerWidth - 168, sx + offX));
      const labelY = Math.max(8, Math.min(window.innerHeight - 84, sy - 14));
      rec.labelEl.style.transform = 'translate3d(' + labelX + 'px,' + labelY + 'px,0)';
      rec.leaderEl.setAttribute('x1', sx.toFixed(1));
      rec.leaderEl.setAttribute('y1', sy.toFixed(1));
      rec.leaderEl.setAttribute('x2', (labelX - 2).toFixed(1));
      rec.leaderEl.setAttribute('y2', (labelY + 10).toFixed(1));
    });

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

    _tickComets();
    _renderer.render(_scene, _camera);
  }

  // -------------------- Dispatch beacon (V3 ribbon) --------------------
  // Single Line drawn from origin to the dispatched agent; a short
  // lumnious head slides outward via setDrawRange.
  function fireBeacon(toName) {
    if (!_threeReady || !_THREE || !_scene) return;
    const rec = _agentRecords.find(function (r) { return r.name === toName; });
    if (!rec || !rec.mesh) return;
    const segs = 48;
    const positions = new Float32Array((segs + 1) * 3);
    const colors = new Float32Array((segs + 1) * 3);
    const baseCol = new _THREE.Color(rec.data.color);
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const eased = t * t * (3 - 2 * t);
      positions[s * 3]     = rec.mesh.position.x * eased;
      positions[s * 3 + 1] = rec.mesh.position.y * eased + Math.sin(t * Math.PI) * 26;
      positions[s * 3 + 2] = rec.mesh.position.z * eased + Math.sin(t * Math.PI) * 12;
      const head = Math.pow(1 - t, 1.8);
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
      opacity: 0.90,
      blending: _THREE.AdditiveBlending,
      depthWrite: false,
    });
    const line = new _THREE.Line(geo, mat);
    _scene.add(line);
    _comets.push({ line: line, geo: geo, mat: mat, startedAt: performance.now(), durationMs: 1200, segs: segs });
    _pulseUntil[toName] = performance.now() + 1600;
  }

  function _tickComets() {
    const now = performance.now();
    for (let i = _comets.length - 1; i >= 0; i--) {
      const c = _comets[i];
      const age = now - c.startedAt;
      const t = Math.min(1.0, age / c.durationMs);
      const headWidth = 12;
      const drawCount = Math.round((t * c.segs) + headWidth);
      c.line.geometry.setDrawRange(Math.max(0, drawCount - headWidth), Math.min(c.segs + 1, drawCount));
      c.mat.opacity = Math.max(0, (1 - t) * 0.90);
      if (age > c.durationMs + 350) {
        try { if (c.line.parent) c.line.parent.removeChild(c.line); } catch (_e) {}
        try { c.geo.dispose(); c.mat.dispose(); } catch (_e) {}
        _comets.splice(i, 1);
      }
    }
  }

  // -------------------- Resize / Esc helpers --------------------
  let _resizeTimer = null;
  function _onResize() {
    if (!_canvasHost) return;
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(function () {
      if (_camera && _renderer) {
        _camera.aspect = window.innerWidth / window.innerHeight;
        _camera.updateProjectionMatrix();
        _renderer.setSize(window.innerWidth, window.innerHeight, false);
      }
    }, 200);
  }

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
    if (_resizeTimer) { try { clearTimeout(_resizeTimer); } catch (_e) {} _resizeTimer = null; }
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
    if (_comets) {
      _comets.forEach(function (c) { try { if (c.line.parent) c.line.parent.removeChild(c.line); c.geo.dispose(); c.mat.dispose(); } catch (_e) {} });
      _comets = [];
    }
    _coreMesh = null; _sonarRing = null; _dataRing = null; _starMesh = null;
    _pulseUntil = Object.create(null);
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
