# Changelog

## [2.0.2](https://github.com/arenaxr/arena-persist/compare/v2.0.1...v2.0.2) (2025-01-17)


### Bug Fixes

* desc of asyncForEach ([63bfa49](https://github.com/arenaxr/arena-persist/commit/63bfa49463413c1170a09fd4378e91f2f29c5a90))

## [2.0.1](https://github.com/arenaxr/arena-persist/compare/v2.0.0...v2.0.1) (2025-01-08)


### Bug Fixes

* broken publishes for expires/create ([9051952](https://github.com/arenaxr/arena-persist/commit/9051952f06f8aa4c73996fc0c13ccf8429b2dc5b))
* clean up persists set w/ scene delete ([af0c488](https://github.com/arenaxr/arena-persist/commit/af0c4881eb379d476d91a76c4b884ce4c3f2825e))
* typos ([7109b62](https://github.com/arenaxr/arena-persist/commit/7109b62d11ce38c4028d796d1b3e05501747ba81))

## [2.0.0](https://github.com/arenaxr/arena-persist/compare/v1.0.4...v2.0.0) (2024-11-07)


### ⚠ BREAKING CHANGES

* Refactored topic structure for more granular flow and access ([#26](https://github.com/arenaxr/arena-persist/issues/26))

### Features

* Refactored topic structure for more granular flow and access ([#26](https://github.com/arenaxr/arena-persist/issues/26)) ([6f2a5ed](https://github.com/arenaxr/arena-persist/commit/6f2a5edd42b232f32b74a3801a458acfad1cabc5))


### Bug Fixes

* make release please trigger other workflows (using a PAT) ([c27263c](https://github.com/arenaxr/arena-persist/commit/c27263c572bdb6ad01cd059d7660e3ee189313f1))
* **mqtt:** require userClient in topic for all scene messages ([#32](https://github.com/arenaxr/arena-persist/issues/32)) ([4f93e84](https://github.com/arenaxr/arena-persist/commit/4f93e84ee7c96b5e7d02ae04589fe2521967aa18))

## [1.0.4](https://github.com/arenaxr/arena-persist/compare/v1.0.3...v1.0.4) (2024-04-01)


### Bug Fixes

* catch promise, not callback param ([a78a689](https://github.com/arenaxr/arena-persist/commit/a78a68925fe33841c422cd30b6afeecdaf2fbc47))
* use correct sig for exec promise ret ([ece873b](https://github.com/arenaxr/arena-persist/commit/ece873b0673e8b94a3175c3d3727cabce3184d49))

## [1.0.3](https://github.com/arenaxr/arena-persist/compare/v1.0.2...v1.0.3) (2023-05-06)


### Bug Fixes

* force object for attributes ([5c3b328](https://github.com/arenaxr/arena-persist/commit/5c3b328b2705e2f41f7da33f31d165eff32664a2))

## [1.0.2](https://github.com/conix-center/arena-persist/compare/v1.0.1...v1.0.2) (2022-07-14)


### Bug Fixes

* mongodb uri str, add index w/ Schema.index() ([f87e4ea](https://github.com/conix-center/arena-persist/commit/f87e4ead86c92008ca06e5fbfbd9a87bad9c84b6))
* path prefix for health endpoint ([8c95245](https://github.com/conix-center/arena-persist/commit/8c95245d0177f34561f31d7c3406d69f605c41da))
* remove deprecated connect params ([a847dfb](https://github.com/conix-center/arena-persist/commit/a847dfbaa182ac849e71dc8fb9380ec246cff79a))
* resolve promise to key ([b17dc7a](https://github.com/conix-center/arena-persist/commit/b17dc7adc2d6fb16f1c9890e45b7ff86e7f9fe53))
* restore rolled back route ([351e9eb](https://github.com/conix-center/arena-persist/commit/351e9eb4e13a71e8eb3dd696df6a3773c306092c))
* set jwtPayload as promise result ([25166be](https://github.com/conix-center/arena-persist/commit/25166bee81fbc79978afa05c2b68472a53c7734a))
* Use try/catch blocks for await over callback ([5f53c03](https://github.com/conix-center/arena-persist/commit/5f53c0341e0e827d47de08ed193e9ab6a0f75bb6))
