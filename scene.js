import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";

const container = document.getElementById("canvas-container");

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15140f);

export const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
camera.position.set(0, 0, 26);

export const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

export const lineResolution = new THREE.Vector2();

function onResize() {
  const w = container.offsetWidth;
  const h = container.offsetHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  lineResolution.set(w, h);
  scene.traverse((obj) => {
    if (obj.isLineSegments2 && obj.material?.isLineMaterial) {
      obj.material.resolution.copy(lineResolution);
    }
  });
}
window.addEventListener("resize", onResize);
onResize();

export const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.055;
controls.minDistance = 12;
controls.maxDistance = 80;

export const starPoints = (() => {
  const count = 5000;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const phi = Math.acos(2 * Math.random() - 1);
    const theta = Math.random() * Math.PI * 2;
    const r = 600 + Math.random() * 400;
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.cos(phi);
    pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.5,
      transparent: true,
      opacity: 0.65,
      sizeAttenuation: true,
    }),
  );
})();
scene.add(starPoints);

export const sphereGroup = new THREE.Group();
scene.add(sphereGroup);

const sphereGeo = new THREE.SphereGeometry(10, 128, 64);
export const sphereMat = new THREE.MeshStandardMaterial({
  color: 0x9aa0a8,
  roughness: 0.8,
  metalness: 0.0,
});
export const sphere = new THREE.Mesh(sphereGeo, sphereMat);
sphereGroup.add(sphere);

export const atmosMat = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    varying vec3 vNormal; varying vec3 vViewDir;
    void main() {
      vNormal  = normalize(normalMatrix * normal);
      vec4 mvp = modelViewMatrix * vec4(position, 1.0);
      vViewDir = normalize(-mvp.xyz);
      gl_Position = projectionMatrix * mvp;
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec3 vNormal; varying vec3 vViewDir;
    uniform vec3 glowColor; uniform float intensity;
    void main() {
      float rim = pow(1.0 - max(dot(vViewDir, vNormal), 0.0), 3.2);
      gl_FragColor = vec4(glowColor, rim * intensity);
    }
  `,
  uniforms: {
    glowColor: { value: new THREE.Color(0x4488ff) },
    intensity: { value: 0.9 },
  },
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.FrontSide,
});
export const atmosSphere = new THREE.Mesh(
  new THREE.SphereGeometry(10.85, 64, 32),
  atmosMat,
);
atmosSphere.visible = false;
sphereGroup.add(atmosSphere);

function buildGraticule(R = 10.06) {
  const SEG = 128,
    pts = [];
  const addArc = (ps) => {
    for (let i = 0; i < ps.length - 1; i++) {
      const a = ps[i],
        b = ps[i + 1];
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  };
  for (let lat = -75; lat <= 75; lat += 15) {
    const phi = (90 - lat) * (Math.PI / 180),
      row = [];
    for (let i = 0; i <= SEG; i++) {
      const t = (i / SEG) * Math.PI * 2;
      row.push(
        new THREE.Vector3(
          R * Math.sin(phi) * Math.cos(t),
          R * Math.cos(phi),
          R * Math.sin(phi) * Math.sin(t),
        ),
      );
    }
    addArc(row);
  }
  for (let lon = 0; lon < 360; lon += 15) {
    const th = lon * (Math.PI / 180),
      col = [];
    for (let i = 0; i <= SEG; i++) {
      const p = (i / SEG) * Math.PI;
      col.push(
        new THREE.Vector3(
          R * Math.sin(p) * Math.cos(th),
          R * Math.cos(p),
          R * Math.sin(p) * Math.sin(th),
        ),
      );
    }
    addArc(col);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const l = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.16,
    }),
  );
  l.visible = false;
  return l;
}
export const graticule = buildGraticule();
sphereGroup.add(graticule);

function buildPoleMarker(isNorth) {
  const g = new THREE.Group(),
    R = 10.1,
    y = isNorth ? R : -R,
    dir = isNorth ? 1 : -1;
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xc8a664 }),
  );
  dot.position.set(0, y, 0);
  g.add(dot);
  const lg = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, y, 0),
    new THREE.Vector3(0, y + dir * 1.6, 0),
  ]);
  g.add(
    new THREE.Line(
      lg,
      new THREE.LineBasicMaterial({
        color: 0xc8a664,
        transparent: true,
        opacity: 0.55,
      }),
    ),
  );
  g.visible = false;
  return g;
}
export const northPole = buildPoleMarker(true);
export const southPole = buildPoleMarker(false);
sphereGroup.add(northPole);
sphereGroup.add(southPole);

export const ambientLight = new THREE.AmbientLight(0xffffff, 0.2);
scene.add(ambientLight);
export const dirLight = new THREE.DirectionalLight(0xffffff, 2.5);
dirLight.position.set(10, 10, 10);
scene.add(dirLight);

export const texLoader = new THREE.TextureLoader();
export const ktx2Loader = new KTX2Loader()
  .setTranscoderPath("https://unpkg.com/three@0.160.0/examples/jsm/libs/basis/")
  .detectSupport(renderer);

export const BG_DARK = new THREE.Color(0x15140f);
export const BG_LIGHT = new THREE.Color(0xfaf9f5);
