# jpeg-js 0.4.4 decoder

`decoder.cjs` is copied from the pinned `jpeg-js@0.4.4` `lib/decoder.js`.
Upstream SHA-256: `a3f175fd6f62d142aad94d3bd90f3a30be4e076baf9b6a6fa31c8e84d9d4aa9f`.
The original copyright/license header is retained. `LICENSE` is the package's BSD license;
`Apache-2.0.txt` contains the decoder's Apache license.

The only functional addition is the `validateOversizedProfile` branch after
`decoder.parse(arr)`. For dimensions over 512, it skips RGB output rendering while
retaining output-memory accounting, supported-color checks, and component-row
dereference checks. All entropy decoding, progressive scans, quantization, IDCT,
and parser checks remain unchanged. Images within 512 use the original output path.

Only the profile-image worker uses this module. Posts and RealMoji retain the
unmodified dependency. Differential tests compare rejection and dimensions to it.
