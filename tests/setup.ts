// In the page, vendor/luna.global.js defines the Luna global before dist/main.js runs. Tests
// run in node, so define it from the SDK module before any test imports src/.
import { Luna } from '@uaudio/luna-builder-sdk';

Object.assign(globalThis, { Luna });
