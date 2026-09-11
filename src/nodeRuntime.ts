// AFFiNE stores data through its server APIs. This executable does not use Node's
// optional Web Storage. Remove its lazy accessor before browser-oriented
// dependencies probe it; on recent Node versions that probe emits a warning even
// when the dependency correctly catches the unavailable-storage exception.
// Preserve any explicitly installed value/polyfill and do not read the getter.
const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
if (storage?.get && storage.configurable) {
  Reflect.deleteProperty(globalThis, "localStorage");
}
