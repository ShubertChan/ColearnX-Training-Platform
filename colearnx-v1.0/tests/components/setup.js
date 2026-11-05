import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
afterEach(() => { cleanup(); vi.useRealTimers(); });
Object.defineProperty(HTMLMediaElement.prototype, "load", { configurable: true, value() {} });
Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value() {} });
Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value() { return Promise.resolve(); } });
// jsdom has no layout engine; real overflow and resize behavior is covered in browser tests.
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
