# Retained Code Mode programs

These five text files contain the exact submitted programs published in
[issue #85](https://github.com/BjRo/sevro/issues/85). Tests inspect them through
the native-session observation path; they never execute the command or patch
payloads. Historical temporary paths are input bytes, not prerequisites.

The original local transcript bundles and decoded JSONL source were verified
against the issue's SHA-256 values before extracting each `payload.input`.

| Files                                             | Native source SHA-256                                              | Bundle SHA-256                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `direct-45.txt`, `direct-69.txt`, `direct-77.txt` | `db6a4551f0e9fd8e793ebdd9ab485b0c57a8643b860f4229171f96e2bb3a50cf` | `9fb9230ef7317581a86bd26eecd095938069c51a095bc6149e6a8c0a7a51e851` |
| `coupled-30.txt`, `coupled-68.txt`                | `d594d0968e4f42a94a00bedb626dabdc0a9f391c5c3a110c82f3aeca84dd0403` | `d74889d59abb5002e83493fab493419d416212cb3e261fd46e5e8d22fe0b8f4f` |

The file suffix is the zero-based native submission ordinal. Tests preserve
that ordinal and assert the ordered, submission-local call indexes.
