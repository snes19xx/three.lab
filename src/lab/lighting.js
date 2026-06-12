import { ambientLight, dirLight } from "./scene.js";
import { state } from "./state.js";

export function applyCustomLight() {
  const az  = parseFloat(document.getElementById("lightAzimuth").value)   * (Math.PI / 180);
  const el  = parseFloat(document.getElementById("lightElevation").value)  * (Math.PI / 180);
  const int = parseFloat(document.getElementById("lightIntensity").value);
  dirLight.position.set(
    20 * Math.cos(el) * Math.sin(az),
    20 * Math.sin(el),
    20 * Math.cos(el) * Math.cos(az)
  );
  ambientLight.intensity = 0.15;
  dirLight.intensity     = int;
}

export function applyLightMode(mode) {
  state.lightMode = mode;
  ["lightDirect", "lightAmbient", "lightCustom"].forEach((id) =>
    document.getElementById(id).classList.remove("active")
  );
  if (mode === "direct") {
    document.getElementById("lightDirect").classList.add("active");
    ambientLight.intensity = 0.2;
    dirLight.intensity     = 2.5;
    dirLight.position.set(10, 10, 10);
  } else if (mode === "ambient") {
    document.getElementById("lightAmbient").classList.add("active");
    ambientLight.intensity = 2.5;
    dirLight.intensity     = 0;
  } else {
    document.getElementById("lightCustom").classList.add("active");
    applyCustomLight();
  }
}
