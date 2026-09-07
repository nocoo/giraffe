# Giraffe brand assets

An ochre giraffe pauses with one multicolored acacia sprig in its mouth. Both ossicones and ears stay complete, with the diagonal upper neck continuing naturally through the lower edge.

## Use by surface

| Surface | Asset | Treatment |
| --- | --- | --- |
| README header / large gallery | `assets/brand/icon-rounded.png` | Selected rounded presentation, shown at 128 px in README |
| Sidebar in both states | `public/logo-24.png` via `src/client/components/layout/mark.tsx` | Transparent foreground rendered at 20 px, with no crop. |
| Browser | `public/logo-32.png` | Transparent 32 px PNG, declared in `index.html`. |
| Apple touch | `public/apple-touch-icon.png` | Opaque 180 px square presentation; platform masking is independent of browser favicon behavior. |

Root `logo.png` is the canonical 2048 × 2048 transparent foreground. `assets/brand/icon.png` and `icon-rounded.png` are separate square and rounded presentation masters. Small application and browser marks use the transparent foreground without a baked-in background, glow, color filter, or extra circular mask. Larger README, native-install, and social surfaces may use the designed background according to their platform contract.

## Rebuild and provenance

```sh
./scripts/resize-logos.sh
```

One native image request. Azure Foundry `gpt-image-2`, native 2048 × 2048; selected study `2026-09-07-01`, finishing `02`. The owner delegated intermediate acceptance for this named five-project batch. The recorded agent inspection is not a claim that the owner reviewed the returned image bytes.

The smallest protected-feature clearance is **164.64 px** against the actual 23% rounded outline. Intentional lower neck/shoulder intersections are recorded separately; no expressive feature or accessory is clipped. The selected extraction preserves every fully opaque native RGB pixel. All artwork, background, grain, and shadow layers remain separate in the Hexly study.

The presentation uses **Acacia canopy relief**, with base `#79865b`, light `#b9c398`, shade `#4b5c39`, and motif `#354629`. Product UI colors remain independent. [source.json](source.json) records exact master hashes and the prior source identity.

- [Individual before/after page](https://hexly.ai/logos/giraffe)
- [Complete generation and finishing archive](https://github.com/nocoo/hexly.ai/tree/main/artwork/logo-family/giraffe/2026-09-07-01)
- [Local static review](https://index.dev.hexly.ai/artwork/logo-family/giraffe/2026-09-07-01/review.html)
- [Shared usage SOP](https://github.com/nocoo/hexly.ai/blob/main/docs/07-logo-usage-sop.md)
