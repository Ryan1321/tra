# Barcode scanner dependencies

## Automatic camera reader: zxing-wasm 3.1.4

The live camera scanner uses the native browser detector when available, with
the local WebAssembly reader as a fallback in a dedicated worker. These files
are unmodified copies from the npm package:

- Package: https://registry.npmjs.org/zxing-wasm/-/zxing-wasm-3.1.4.tgz
- Upstream: https://github.com/Sec-ant/zxing-wasm/tree/v3.1.4
- Package SHA-1: `a8761880274aa0d2c8d65a943562b262528e66a4`
- Package SHA-256: `2416232a155533bdcfa098a22ec9087734b34640ffa2a7add90bc36e145f6da0`
- `dist/iife/reader/index.js` becomes `zxing-wasm-3.1.4-reader.js`;
  SHA-256: `d33d09ce132a692faffbed0dce656c36cb2573b4b843885a6e036390d1071d95`.
- `dist/reader/zxing_reader.wasm` becomes `zxing-wasm-3.1.4-reader.wasm`;
  SHA-256: `e8af31edb56d0522f4de74495839385ef019ba8bc90d38e5ecb2f18795d86fb2`.
- The bundle reports ZXing-C++ commit
  `0b2d9a8fc81f420f369928c24331091ff0525976`.

Licenses are preserved alongside these files:

- `zxing-wasm-LICENSE.txt`: package JavaScript, MIT.
- `zxing-wasm-cpp-LICENSE.txt`: package C++ bindings, Apache-2.0.
- `zxing-cpp-LICENSE.txt`: ZXing-C++ core, Apache-2.0, copied from the exact
  commit above. That upstream repository has no root `NOTICE` file.
- `stb-LICENSE.txt`: stb image-loading code compiled into the reader, MIT or
  public-domain alternative. Upstream's CMake build fetches stb without pinning
  its revision; the distributed WebAssembly binary is pinned by the hash above.
- `zxing-wasm-NOTICES.txt`: source attribution and provenance.

The app's image preprocessing is in `../tra-auto-worker.js`; it does not modify
the vendor decoder. Barcode regions and tilt are detected automatically.

## Previous photo reader (retained): @zxing/browser 0.1.5

`zxing-browser-0.1.5.min.js` is the unmodified UMD browser bundle from
`@zxing/browser` version **0.1.5**, downloaded from the npm registry:

- Package: https://registry.npmjs.org/@zxing/browser/-/browser-0.1.5.tgz
- Upstream: https://github.com/zxing-js/browser
- Package SHA-1: `94c0cdbc8ab5114a82dadee54939de6d9bf7e313`
- Bundle SHA-256: `b5ad3df920738ca7adcb74508d7e6b6a5b9024993fb9a0c702da1ad8964eca07`

The bundle includes the ZXing core decoder. Copyright notices from the
unminified upstream source are preserved in `zxing-NOTICES.txt`. Browser-layer
MIT and core Apache-2.0 license texts are provided in
`zxing-browser-LICENSE.txt` and `zxing-library-LICENSE.txt`.

The current scanner uses zxing-wasm for both live frames and saved photos. The
previous browser decoder is retained with its licenses but is not loaded by the
live scanner. The application loads active decoder files from the Windows PC only when scanning begins.
There are no CDN requests at runtime. Camera frames and photos are decoded on
the phone and are never uploaded; only the decoded product barcode is sent to
the catalog API.
