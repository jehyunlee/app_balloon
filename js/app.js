(function(){
  // ---------- model constants ----------
  const R0 = 1.0;        // unstretched radius
  const EMAX = 1.1;      // max base strain at 100% inflation
  const GAMMA = 1.4;     // amplification: thin rubber thins further as it stretches
  const BURST = 3.4;     // stretch ratio at which rubber bursts
  const SIG2 = 0.075;    // smoothing width (neighbours hold each other)

  const NORMAL_HEX = '#2f6bff', THIN_HEX = '#ffb21e';

  // ---------- renderer / scene ----------
  const stage = document.getElementById('stage');
  const renderer = new THREE.WebGLRenderer({antialias:true, alpha:true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  stage.insertBefore(renderer.domElement, stage.firstChild);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0.8, 0.9, 9.6);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.enablePan = false; controls.minDistance = 4; controls.maxDistance = 20;
  controls.target.set(0, 0.25, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x6f7a8f, 0.75));
  const key = new THREE.DirectionalLight(0xffffff, 0.95); key.position.set(4, 6, 7); scene.add(key);
  const rim = new THREE.DirectionalLight(0xcfe0ff, 0.45); rim.position.set(-6, -2, -5); scene.add(rim);

  // ---------- 60 equal regions: icosahedron faces split into 3 kites ----------
  const PHI = (1 + Math.sqrt(5)) / 2;
  const IV = [[-1,PHI,0],[1,PHI,0],[-1,-PHI,0],[1,-PHI,0],[0,-1,PHI],[0,1,PHI],[0,-1,-PHI],[0,1,-PHI],[PHI,0,-1],[PHI,0,1],[-PHI,0,-1],[-PHI,0,1]]
    .map(a => new THREE.Vector3(a[0],a[1],a[2]).normalize());
  // rotate so one vertex points straight down (where the knot sits)
  const rot = new THREE.Matrix4().makeRotationZ(-Math.PI/2 - Math.atan2(-PHI,-1));
  IV.forEach(v => v.applyMatrix4(rot));
  const IF = [[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],
              [3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
  const faceC = IF.map(f => new THREE.Vector3().add(IV[f[0]]).add(IV[f[1]]).add(IV[f[2]]).normalize());
  const faceV = [], regC = [];
  IF.forEach((f, fi) => {
    for (let k = 0; k < 3; k++) {
      const V = IV[f[k]], A = IV[f[(k+1)%3]], B = IV[f[(k+2)%3]];
      faceV.push(V.clone());
      const m1 = V.clone().add(A).normalize(), m2 = V.clone().add(B).normalize();
      regC.push(V.clone().add(m1).add(m2).add(faceC[fi]).normalize());
    }
  });
  function classify(d){
    let bf = 0, b = -2;
    for (let i = 0; i < 20; i++){ const s = d.dot(faceC[i]); if (s > b){ b = s; bf = i; } }
    let bk = 0, bv = -2;
    for (let k = 0; k < 3; k++){ const s = d.dot(faceV[bf*3+k]); if (s > bv){ bv = s; bk = k; } }
    return bf*3 + bk;
  }
  function weightsFor(d){
    const idx = [], w = []; let sum = 0;
    for (let j = 0; j < 60; j++){
      const x = Math.exp(-(1 - d.dot(regC[j])) / SIG2);
      if (x > 0.003){ idx.push(j); w.push(x); sum += x; }
    }
    return {idx, w: w.map(x => x / sum)};
  }

  // ---------- state ----------
  const thin = new Float32Array(60);          // 1 = thin
  const cur  = new Float32Array(60).fill(1);   // current stretch per region
  const tgt  = new Float32Array(60).fill(1);
  let inflate = 0, thinT = 0.6, burst = false, playing = false, dirty = true;

  // ---------- balloon mesh ----------
  let geo = new THREE.IcosahedronGeometry(1, 36);
  geo.deleteAttribute('normal'); geo.deleteAttribute('uv');
  geo = THREE.BufferGeometryUtils.mergeVertices(geo, 1e-5);
  const pos = geo.attributes.position, N = pos.count;
  const dirArr = new Float32Array(N*3);
  const wOff = new Uint32Array(N+1); const wI = [], wV = [];
  const tmp = new THREE.Vector3();
  for (let i = 0; i < N; i++){
    tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    dirArr[3*i] = tmp.x; dirArr[3*i+1] = tmp.y; dirArr[3*i+2] = tmp.z;
    const W = weightsFor(tmp);
    wOff[i] = wI.length;
    for (let k = 0; k < W.idx.length; k++){ wI.push(W.idx[k]); wV.push(W.w[k]); }
  }
  wOff[N] = wI.length;
  const wIdx = Uint8Array.from(wI), wVal = Float32Array.from(wV);
  geo.setAttribute('aDir', new THREE.BufferAttribute(dirArr, 3));

  const uni = {
    uFaceC: {value: faceC}, uFaceV: {value: faceV},
    uTS: {value: Array.from({length:30}, () => new THREE.Vector4(0,1,0,1))},
    uColN: {value: new THREE.Color(NORMAL_HEX).convertSRGBToLinear()},
    uColT: {value: new THREE.Color(THIN_HEX).convertSRGBToLinear()}
  };
  const mat = new THREE.MeshPhysicalMaterial({roughness:0.34, metalness:0, clearcoat:0.75, clearcoatRoughness:0.22});
  mat.extensions = {derivatives:true};
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aDir;\nvarying vec3 vDir;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDir = aDir;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vDir;
uniform vec3 uFaceC[20];
uniform vec3 uFaceV[60];
uniform vec4 uTS[30];
uniform vec3 uColN;
uniform vec3 uColT;`)
      .replace('#include <color_fragment>', `
vec3 d = normalize(vDir);
float b1 = -2.0, b2 = -2.0; int bf = 0;
for (int i = 0; i < 20; i++){ float s = dot(d, uFaceC[i]); if (s > b1){ b2 = b1; b1 = s; bf = i; } else if (s > b2){ b2 = s; } }
float v1 = -2.0, v2 = -2.0; int bid = 0;
for (int j = 0; j < 60; j++){ if (j / 3 == bf){ float s = dot(d, uFaceV[j]); if (s > v1){ v2 = v1; v1 = s; bid = j; } else if (s > v2){ v2 = s; } } }
float th = 0.0, st = 1.0;
int half_ = bid / 2; bool odd = (bid - half_ * 2) == 1;
for (int j = 0; j < 30; j++){ if (j == half_){ vec4 q = uTS[j]; th = odd ? q.z : q.x; st = odd ? q.w : q.y; } }
vec3 base = mix(uColN, uColT, th);
float pale = clamp((st - 1.0) / 3.0, 0.0, 1.0) * 0.22;
base = mix(base, vec3(1.0, 0.96, 0.92), pale);
float g1 = b1 - b2, g2 = v1 - v2;
float e = min(g1 / max(fwidth(g1), 1e-6), g2 / max(fwidth(g2), 1e-6));
float edge = 1.0 - smoothstep(0.5, 1.6, e);
base = mix(base, base * 0.5, edge * 0.85);
diffuseColor.rgb = base;`);
  };
  const balloon = new THREE.Mesh(geo, mat);
  scene.add(balloon);

  // knot
  const knotMat = new THREE.MeshPhysicalMaterial({color:new THREE.Color(NORMAL_HEX), roughness:0.4, clearcoat:0.5});
  const knot = new THREE.Group();
  const neck = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.2, 24), knotMat); neck.position.y = -0.08;
  const bulb = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.035, 10, 24), knotMat); bulb.position.y = -0.2; bulb.rotation.x = Math.PI/2;
  knot.add(neck, bulb); scene.add(knot);
  const downW = weightsFor(new THREE.Vector3(0,-1,0));

  function syncTS(){
    const a = uni.uTS.value;
    for (let j = 0; j < 30; j++) a[j].set(thin[2*j], cur[2*j], thin[2*j+1], cur[2*j+1]);
  }
  function radiusFrom(W){ let r = 0; for (let k = 0; k < W.idx.length; k++) r += W.w[k] * cur[W.idx[k]]; return r * R0; }

  function updateGeometry(){
    const p = pos.array;
    for (let i = 0; i < N; i++){
      let r = 0;
      for (let k = wOff[i]; k < wOff[i+1]; k++) r += wVal[k] * cur[wIdx[k]];
      r *= R0;
      p[3*i] = dirArr[3*i]*r; p[3*i+1] = dirArr[3*i+1]*r; p[3*i+2] = dirArr[3*i+2]*r;
    }
    pos.needsUpdate = true;
    syncTS();
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    knot.position.y = -radiusFrom(downW) + 0.03;
  }

  // ---------- model ----------
  function computeTargets(){
    const e = EMAX * inflate;
    for (let j = 0; j < 60; j++){
      const t = thin[j] ? thinT : 1;
      tgt[j] = 1 + e * Math.pow(1 / t, 1 + GAMMA * e);
    }
  }

  // ---------- burst particles ----------
  let shards = [];
  function doBurst(j){
    burst = true; playing = false; syncAuto();
    const d = regC[j].clone();
    const origin = d.clone().multiplyScalar(cur[j] * R0 * 0.9);
    balloon.visible = false; knot.visible = false;
    const triGeo = new THREE.BufferGeometry();
    triGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0,0.12,0, -0.1,-0.08,0, 0.11,-0.06,0]), 3));
    for (let i = 0; i < 70; i++){
      const isThin = Math.random() < 0.35;
      const m = new THREE.Mesh(triGeo, new THREE.MeshBasicMaterial({color: isThin ? THIN_HEX : NORMAL_HEX, side:THREE.DoubleSide, transparent:true}));
      const rd = new THREE.Vector3(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5).normalize();
      m.position.copy(rd.clone().multiplyScalar(1.4 + Math.random()*0.6));
      const v = rd.clone().multiplyScalar(2 + Math.random()*3).add(d.clone().multiplyScalar(3 + Math.random()*3));
      m.userData = {v, spin: new THREE.Vector3(Math.random()*8, Math.random()*8, Math.random()*8), life: 1};
      m.position.add(origin.clone().multiplyScalar(0.4));
      scene.add(m); shards.push(m);
    }
    document.getElementById('burstMsg').textContent =
      `가장 얇은 곳이 원래보다 ${BURST.toFixed(1)}배 넘게 늘어나서 버티지 못하고 터졌어요.`;
    document.getElementById('burst').classList.add('on');
    try { navigator.vibrate && navigator.vibrate(90); } catch(e){}
    elInflate.disabled = true; btnAuto.disabled = true;
  }
  function resetBurst(){
    shards.forEach(s => { scene.remove(s); s.material.dispose(); }); shards = [];
    burst = false; inflate = 0; cur.fill(1); computeTargets();
    balloon.visible = true; knot.visible = true; dirty = true;
    document.getElementById('burst').classList.remove('on');
    elInflate.disabled = false; btnAuto.disabled = false;
    syncInflateUI();
  }

  // ---------- UI ----------
  const elInflate = document.getElementById('inflate'), infOut = document.getElementById('infOut');
  const elThk = document.getElementById('thickness'), thkOut = document.getElementById('thkOut');
  const btnAuto = document.getElementById('auto');
  const elState = document.getElementById('state'), elCount = document.getElementById('thinCount'), elMax = document.getElementById('maxStretch');
  const hint = document.getElementById('hint');

  function syncInflateUI(){ elInflate.value = (inflate*100).toFixed(1); infOut.textContent = Math.round(inflate*100) + '%'; }
  function syncAuto(){ btnAuto.textContent = playing ? '멈추기' : '자동으로 불기'; btnAuto.classList.toggle('playing', playing); }
  function setInflate(v){ inflate = Math.max(0, Math.min(1, v)); computeTargets(); syncInflateUI(); }

  elInflate.addEventListener('input', () => { playing = false; syncAuto(); setInflate(elInflate.value / 100); });
  elThk.addEventListener('input', () => { thinT = elThk.value / 100; thkOut.textContent = `정상의 ${elThk.value}%`; computeTargets(); });
  btnAuto.addEventListener('click', () => { if (burst) return; if (inflate >= 1) setInflate(0); playing = !playing; syncAuto(); });
  document.getElementById('deflate').addEventListener('click', () => { if (burst) resetBurst(); playing = false; syncAuto(); setInflate(0); });
  document.getElementById('resetBurst').addEventListener('click', resetBurst);

  function viewDir(){ return camera.position.clone().sub(controls.target).normalize(); }
  function setThin(fn){ for (let j = 0; j < 60; j++) thin[j] = fn(j) ? 1 : 0; afterThinChange(); }
  function afterThinChange(){
    computeTargets(); syncTS();
    elCount.textContent = thin.reduce((a,b)=>a+b, 0);
  }
  document.getElementById('pOne').addEventListener('click', () => { const v = viewDir(); let best = 0, b = -2; regC.forEach((c,j)=>{ const s=c.dot(v); if(s>b){b=s;best=j;} }); setThin(j => j === best); });
  document.getElementById('pSide').addEventListener('click', () => { const v = viewDir(); setThin(j => regC[j].dot(v) > 0.3); });
  document.getElementById('pBand').addEventListener('click', () => setThin(j => Math.abs(regC[j].y) < 0.3));
  document.getElementById('pRandom').addEventListener('click', () => { const pick = new Set(); while (pick.size < 6) pick.add(Math.floor(Math.random()*60)); setThin(j => pick.has(j)); });
  document.getElementById('pClear').addEventListener('click', () => setThin(() => false));

  // tap to toggle
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', e => { down = {x:e.clientX, y:e.clientY, t:performance.now()}; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t;
    down = null;
    if (moved > 8 || dt > 450 || burst) return;
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left)/r.width)*2 - 1, -((e.clientY - r.top)/r.height)*2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(balloon)[0];
    if (!hit) return;
    const j = classify(hit.point.clone().normalize());
    thin[j] = thin[j] ? 0 : 1;
    afterThinChange();
    hint.classList.add('gone');
  });

  // ---------- resize ----------
  function resize(){
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h,1);
    camera.fov = camera.aspect < 0.8 ? 54 : 40;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage); resize();

  // ---------- status ----------
  function updateStatus(){
    const base = 1 + EMAX * inflate;
    let mx = 1; for (let j = 0; j < 60; j++) if (cur[j] > mx) mx = cur[j];
    elMax.textContent = '×' + mx.toFixed(2);
    elState.className = 'chip state';
    if (burst){ elState.textContent = '터짐!'; elState.classList.add('warn'); }
    else if (mx > BURST * 0.82){ elState.textContent = '위험! 곧 터져요'; elState.classList.add('warn'); }
    else if (mx - base > 0.18){ elState.textContent = '얇은 곳이 볼록 튀어나옴'; elState.classList.add('bulge'); }
    else if (inflate < 0.01){ elState.textContent = '바람 없음'; }
    else { elState.textContent = '고르게 부풀어 오름'; }
  }

  // ---------- loop ----------
  computeTargets(); afterThinChange();
  let last = performance.now(), statusTick = 0;
  function frame(now){
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (playing && !burst){ setInflate(inflate + dt * 0.1); if (inflate >= 1){ playing = false; syncAuto(); } }
    if (!burst){
      const k = 1 - Math.exp(-dt * 5);
      let moved = false, bj = -1;
      for (let j = 0; j < 60; j++){
        const dlt = (tgt[j] - cur[j]) * k;
        if (Math.abs(dlt) > 1e-5){ cur[j] += dlt; moved = true; }
        if (cur[j] >= BURST && bj < 0) bj = j;
      }
      if (moved || dirty){ updateGeometry(); dirty = false; }
      if (bj >= 0) doBurst(bj);
    }
    if (shards.length){
      shards.forEach(s => {
        const u = s.userData; u.v.y -= 9 * dt; u.v.multiplyScalar(0.985);
        s.position.addScaledVector(u.v, dt);
        s.rotation.x += u.spin.x*dt; s.rotation.y += u.spin.y*dt; s.rotation.z += u.spin.z*dt;
        u.life -= dt * 0.55; s.material.opacity = Math.max(0, u.life);
      });
    }
    if ((statusTick += dt) > 0.08){ statusTick = 0; updateStatus(); }
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
