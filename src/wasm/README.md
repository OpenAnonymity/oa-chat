# OA Inference Ticket WASM Module

This directory contains the WebAssembly build of the Privacy Pass library for publicly verifiable tokens (RSA blind signatures) used in OpenAnonymity's inference ticket system.

## Files

- `oa_inference_ticket.js` - JavaScript bindings and WASM loader
- `oa_inference_ticket_bg.wasm` - Compiled WebAssembly binary

## Source

These files are compiled from the Rust implementation at:
`/privacy-pass-python/wasm/`

## Why in src/ instead of public/?

The WASM files are placed in `src/` (not `public/`) because:
- Webpack can properly bundle and optimize them
- ES module imports work correctly
- WASM binary is included in the build automatically
- Better development experience with hot reloading

## Rebuild Instructions

If you need to rebuild the WASM module:

```bash
cd ../../../../privacy-pass-python/wasm
bash build.sh
cp pkg/oa_inference_ticket.js pkg/oa_inference_ticket_bg.wasm ../../oa-web-app/client/src/wasm/
```

## Usage

The webapp automatically loads these files via the `WasmDirectProvider` in `src/shared/services/privacyPass.js`:

```javascript
const wasmModule = await import('../../wasm/oa_inference_ticket.js');
await wasmModule.default(); // Initialize WASM
```

No manual script loading or public folder configuration required - webpack handles everything.
