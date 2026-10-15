# Environment texture provenance

These files were copied unchanged from the reference application's
`di-app-athon/public/spatial/` directory. They are the default assets used by
Takram's `three-geospatial` atmosphere and cloud packages:

- `local_weather.png`, `shape.bin`, `shape_detail.bin`, and `turbulence.png`:
  <https://github.com/takram-design-engineering/three-geospatial/tree/45a1c6c1bb9fd38b3680fd120795ff4c32df68ff/packages/clouds/assets>
- `stbn.bin`:
  <https://github.com/takram-design-engineering/three-geospatial/tree/9627216cc50057994c98a2118f3c4a23765d43b9/packages/core/assets>

Upstream project license: MIT, copyright (c) 2024 Shota Matsuda.
The license text is retained in `LICENSE-three-geospatial.txt`.

Atmospheric lookup textures are generated on the GPU at runtime. These cloud
textures contain no map-provider imagery or utility data.
