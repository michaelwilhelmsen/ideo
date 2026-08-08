# Third-Party Notices

Ideo is Copyright (c) 2026 Michael Wilhelmsen and licensed under the
GNU Affero General Public License v3.0 — see [LICENSE](LICENSE).

This file records third-party work included in or derived from this project,
along with the notices those works require to be retained.

## Application scaffold

The application scaffold — build tooling, Tauri configuration, window and
preferences plumbing, command palette, i18n setup, and the developer
documentation patterns in `docs/developer/` — derives from
**[dannysmith/tauri-template](https://github.com/dannysmith/tauri-template)**,
used under the MIT License.

The MIT License requires that its copyright and permission notice be retained
in copies and substantial portions of that work. It is reproduced in full below
and **should not be removed**. MIT is permissive rather than copyleft, so it
places no licensing requirement on Ideo's own code, which is why this project
can be AGPL-3.0 while retaining this notice.

```
MIT License

Copyright (c) 2025 Tauri Template Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Dependencies

Runtime and build dependencies are declared in `package.json` and
`src-tauri/Cargo.toml` and retain their own licenses. They are not vendored into
this repository.

One dependency is worth noting for distribution purposes: **ffmpeg**, used for
video export, is invoked as an external system binary installed separately by the
user (`brew install ffmpeg`). It is not bundled, so its licensing does not extend
to this project. That changes if ffmpeg is ever vendored — see the export section
of [`docs/prd/ideo-prd.md`](docs/prd/ideo-prd.md).
