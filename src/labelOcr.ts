// The shape of one page of recognised text.
//
// This is the contract between "something that reads an image" and
// "something that understands a label". Today the reader is ocr.swift
// on a Mac; later it is ML Kit / Vision on the phone. Both produce
// THIS shape, which is why none of the logic below has to change when
// the reader is swapped.
//
// Coordinates are normalised 0..1 with the origin at the TOP-LEFT.

export interface OcrBox {
  x: number; // left edge
  y: number; // top edge
  w: number; // width
  h: number; // height
}

export interface OcrWord {
  text: string;
  box: OcrBox;
}

export interface OcrLine {
  text: string;
  /** Apple Vision reports 0..1. ML Kit reports nothing. Never required by a rule. */
  confidence: number | null;
  box: OcrBox;
  words: readonly OcrWord[];
}

export interface OcrPage {
  source: string;
  width: number;
  height: number;
  engine: string;
  lines: readonly OcrLine[];
}

export const right = (b: OcrBox): number => b.x + b.w;
export const centreY = (b: OcrBox): number => b.y + b.h / 2;

export function medianHeight(lines: readonly OcrLine[]): number {
  if (lines.length === 0) return 0.02;
  const hs = lines.map((l) => l.box.h).sort((a, b) => a - b);
  return hs[Math.floor(hs.length / 2)] ?? 0.02;
}
