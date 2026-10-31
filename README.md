# Noema — interactive particle-head landing page

A single-page studio landing site: a 3D head made of ~57,000 glowing particles floats in a
dark-blue scene with volumetric light beams, framed by an **ENVISION / MATERIALIZE** headline,
navigation, call-to-action buttons and a featured-work card.

**Interaction:** move the mouse near or over the face and the particles follow the cursor —
they get dragged along with it and spring back into place. The whole head also turns slightly
toward the pointer. Works with touch too.

## Run it

No build step and no dependencies. Either:

- open `index.html` directly in a browser, or
- serve the folder (recommended), e.g.

```bash
python3 -m http.server 8000
```

then visit <http://localhost:8000>. It also works as-is on GitHub Pages.

## How it works

| File | What it does |
| --- | --- |
| `index.html` | Page markup (header, headline, intro, buttons, featured card) |
| `css/style.css` | Layout, typography, hover states, entrance animation, responsive rules |
| `js/particles.js` | WebGL renderer: background shader (gradient, god rays, grain), particle head with lighting, depth of field, chromatic aberration and bloom; CPU spring simulation for the mouse interaction |
| `js/main.js` | Live CET clock in the header, mobile menu, entrance animation |
| `js/head-data.js` | The particle positions/normals (generated — see below) |
| `tools/bake-head.mjs` | Script that samples the 3D head scan into `js/head-data.js` |

### Tweaking

Most visual parameters live in the `CFG` object at the top of `js/particles.js`
(head position/rotation, how strongly the head follows the mouse, interaction radius,
drag / spring strength, number of stars…). You can also experiment live from the browser
console, e.g. `NoemaScene.config.radius = 1.4` or `NoemaScene.config.drag = 20`.

### Re-generating the head point cloud

```bash
node tools/bake-head.mjs            # downloads the model from the three.js repo
node tools/bake-head.mjs model.glb 60000   # or use a local GLB and a custom point count
```

The script area-samples the mesh surface, drops the shoulders, and removes hidden interior
surfaces (like the mouth cavity) so only the outer skin becomes particles.

## Credits

- Head model: “Lee Perry-Smith” head scan by [Infinite-Realities](https://www.ir-ltd.net/),
  licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) (as distributed with the three.js examples).
- Fonts: [Italiana](https://fonts.google.com/specimen/Italiana) and
  [Instrument Sans](https://fonts.google.com/specimen/Instrument+Sans), SIL Open Font License (see `fonts/`).
- Simplex noise GLSL by Ian McEwan / Ashima Arts & Stefan Gustavson (MIT).
