// Geometry compression for exported GLBs, via gltf-transform loaded from a CDN.
// Draco and meshopt are the two glTF-standard codecs and where the big geometry
// savings come from. Texture downscaling happens earlier (GLTFExporter's
// maxTextureSize), so this module only handles geometry.
//
// gltf-transform applies these codecs through the extension API (create the
// extension on the document, set encoder options, then writeBinary encodes).

const GT = "https://esm.sh/@gltf-transform";
const VER = "@4";

let modules = null;
async function loadModules() {
  if (!modules) {
    const [core, extensions, functions] = await Promise.all([
      import(`${GT}/core${VER}`),
      import(`${GT}/extensions${VER}`),
      import(`${GT}/functions${VER}`),
    ]);
    if (!core.WebIO) throw new Error("gltf-transform core failed to load");
    modules = { core, extensions, functions };
  }
  return modules;
}

// Draco's encoder/decoder. draco3dgltf is only on esm.sh in module form.
async function loadDraco() {
  const mod = await import("https://esm.sh/draco3dgltf@1.5.7");
  const draco3d = mod.default || mod;
  return {
    "draco3d.encoder": await draco3d.createEncoderModule(),
    "draco3d.decoder": await draco3d.createDecoderModule(),
  };
}

// meshopt's encoder/decoder, from the unpkg path the simplifier already uses.
async function loadMeshopt() {
  const [enc, dec] = await Promise.all([
    import("https://unpkg.com/meshoptimizer@0.22.0/meshopt_encoder.module.js"),
    import("https://unpkg.com/meshoptimizer@0.22.0/meshopt_decoder.module.js"),
  ]);
  await enc.MeshoptEncoder.ready;
  await dec.MeshoptDecoder.ready;
  return { encoder: enc.MeshoptEncoder, decoder: dec.MeshoptDecoder };
}

function toArrayBuffer(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

// Compress a GLB ArrayBuffer with the given codec ('draco' | 'meshopt').
// Returns a new ArrayBuffer. Throws with a descriptive message on failure so
// the caller can show it.
export async function compressGLB(arrayBuffer, mode) {
  const { core, extensions, functions } = await loadModules();
  const input = new Uint8Array(arrayBuffer);

  if (mode === "draco") {
    const Ext = extensions.KHRDracoMeshCompression;
    if (!Ext) throw new Error("KHRDracoMeshCompression not available");
    const io = new core.WebIO()
      .registerExtensions([Ext])
      .registerDependencies(await loadDraco());
    const doc = await io.readBinary(input);
    await doc.transform(functions.dedup(), functions.weld());
    doc
      .createExtension(Ext)
      .setRequired(true)
      .setEncoderOptions({ method: Ext.EncoderMethod.EDGEBREAKER });
    return toArrayBuffer(await io.writeBinary(doc));
  }

  if (mode === "meshopt") {
    const Ext = extensions.EXTMeshoptCompression;
    const Quant = extensions.KHRMeshQuantization;
    if (!Ext) throw new Error("EXTMeshoptCompression not available");
    const { encoder, decoder } = await loadMeshopt();
    const io = new core.WebIO()
      .registerExtensions(Quant ? [Ext, Quant] : [Ext])
      .registerDependencies({
        "meshopt.encoder": encoder,
        "meshopt.decoder": decoder,
      });
    const doc = await io.readBinary(input);
    await doc.transform(
      functions.dedup(),
      functions.reorder({ encoder }),
      functions.quantize(),
    );
    doc
      .createExtension(Ext)
      .setRequired(true)
      .setEncoderOptions({ method: Ext.EncoderMethod.QUANTIZE });
    return toArrayBuffer(await io.writeBinary(doc));
  }

  return arrayBuffer;
}
