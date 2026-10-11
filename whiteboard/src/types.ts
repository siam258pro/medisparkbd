// Shared types for the local smart whiteboard. No network, no AI APIs.
export type ToolKind =
  | 'pen' | 'highlighter' | 'eraser' | 'select'
  | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'sticky' | 'pan';

export type BeautifyStrength = 'subtle' | 'balanced' | 'strong';
export type ScriptPref = 'auto' | 'bangla' | 'english' | 'mixed';

export interface InkPoint {
  x: number;
  y: number;
  /** ms timestamp */
  t: number;
  /** pressure 0..1 when available */
  p?: number;
  /** pointerType at capture: 'pen' | 'touch' | 'mouse' */
  pt?: string;
}

export interface Stroke {
  id: string;
  points: InkPoint[];
  /** immutable raw capture; present after beautification */
  originalPoints?: InkPoint[];
  color: string;
  width: number;
  tool: 'pen' | 'highlighter' | 'line' | 'arrow' | 'rect' | 'ellipse';
  /** handwriting-style font css for converted text strokes */
  font?: string;
  /** original stroke ids replaced by a converted text object */
  replaces?: string[];
  /** render with variable-width (perfect-freehand) outline */
  variableWidth?: boolean;
  /** true when drawn in Handwriting mode (recognition candidate) */
  handwritten?: boolean;
  /** Parametric shape geometry (new shapes). Legacy strokes use points only. */
  shape?: 'line' | 'arrow' | 'rect' | 'ellipse';
  ax?: number; ay?: number; bx?: number; by?: number;
  createdAt: number;
  beautified?: boolean;
  /** set when beautification was applied */
  strength?: BeautifyStrength;
  label?: string;
  text?: string;
  /** sticky/text extra */
  w?: number;
  h?: number;
  isImage?: boolean;
  imgSrc?: string;
}

export interface Camera { x: number; y: number; zoom: number; }

export type BoardTheme = 'night' | 'white';

export interface BoardBackground {
  type: 'none' | 'grid' | 'dots' | 'lines' | 'image';
  imageSrc?: string;
  /** world rect where a custom image bg is anchored */
  ox?: number; oy?: number; w?: number; h?: number;
}

export interface PdfTemplate {
  name: string;
  pages: string[];
  pw: number; ph: number;
  ox: number; oy: number;
  pageIndex: number;
}

export interface Board {
  id: string;
  name: string;
  strokes: Stroke[];
  camera: Camera;
  createdAt: number;
  updatedAt: number;
  theme?: BoardTheme;
  background?: BoardBackground;
  pdf?: PdfTemplate | null;
}

export interface PersonalParams {
  smoothingBias: number; // 0..1 extra smoothing learned from accepts
  slant: number;         // radians, learned dominant slant
  avgHeight: number;     // typical char height px (world units)
  avgWidth: number;      // typical stroke width
  spacing: number;       // typical gap between stroke groups
}

export interface MemoryExample {
  id: string;
  script: 'bangla' | 'english' | 'mixed' | 'numeral' | 'unknown';
  accepted: boolean;
  strength: BeautifyStrength;
  createdAt: number;
  original: InkPoint[][];
  beautified: InkPoint[][];
  avgWidth: number;
  avgHeight: number;
  slant: number;
}

export interface MemoryProfile {
  enabled: boolean;
  params: PersonalParams;
  examples: MemoryExample[];
  accepts: number;
  rejects: number;
}

export function uid(prefix = 's'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}
