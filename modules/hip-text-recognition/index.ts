import { requireNativeModule } from 'expo-modules-core';
import type { OcrPage } from '../../src/labelOcr';
import type { Separator } from '../../src/labelSeparators';

interface Native {
  recognize: (uri: string, minimumTextHeight: number) => Promise<OcrPage>;
  recognizeTiled: (
    uri: string, minimumTextHeight: number, rows: number, cols: number,
  ) => Promise<OcrPage>;
  detectSeparators: (uri: string) => Promise<{ separators: Separator[] }>;
}

// Present only in a native build. Expo Go has no custom native code, so this
// stays null there and the app falls back to the stored reading.
let native: Native | null = null;
try {
  native = requireNativeModule('HipTextRecognition') as Native;
} catch {
  native = null;
}

export const textRecognitionAvailable = (): boolean => native !== null;

/**
 * Read the text off an image, entirely on this device.
 * `minimumTextHeight` is a fraction of image height; 0.008 is low enough
 * to catch 6-point Supplement Facts type.
 */
export async function recognizeText(uri: string, minimumTextHeight = 0.008): Promise<OcrPage> {
  if (native === null) throw new Error('Text recognition needs the native build');
  return native.recognize(uri, minimumTextHeight);
}

/**
 * Read the image in overlapping tiles.
 *
 * `minimumTextHeight` is a fraction of the IMAGE, so the same 6-point panel
 * type is twice as tall relative to a quarter-sized tile as it is to the
 * whole photograph. Cropping is therefore a way of asking the recogniser to
 * look harder, without changing the recogniser. Costs rows x cols passes,
 * so it is only worth it when the plain reads came back thin.
 */
/**
 * Find the hairlines the label prints between its rows.
 *
 * Returns an empty list rather than throwing on any failure: separators are
 * an improvement on row detection, never a prerequisite for it, so a
 * detector that cannot run must cost nothing but the improvement.
 */
export async function detectSeparators(uri: string): Promise<Separator[]> {
  if (native === null || typeof native.detectSeparators !== 'function') return [];
  try {
    const got = await native.detectSeparators(uri);
    return Array.isArray(got.separators) ? got.separators : [];
  } catch {
    return [];
  }
}

export async function recognizeTiled(
  uri: string, minimumTextHeight = 0.008, rows = 2, cols = 2,
): Promise<OcrPage> {
  if (native === null) throw new Error('Text recognition needs the native build');
  if (typeof native.recognizeTiled !== 'function') {
    // An older native build without this function: fall back rather than
    // crash, so a JS-only update can never brick the scanner.
    return native.recognize(uri, minimumTextHeight);
  }
  return native.recognizeTiled(uri, minimumTextHeight, rows, cols);
}
