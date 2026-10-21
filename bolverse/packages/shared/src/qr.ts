import QRCode from "qrcode";

/** The QR code as a square grid of dark (true) and light (false) cells, drawn by each app its own way. */
export function qrMatrix(text: string): boolean[][] {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const rows: boolean[][] = [];
  for (let y = 0; y < n; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < n; x++) row.push(Boolean(qr.modules.get(x, y)));
    rows.push(row);
  }
  return rows;
}

/** One SVG path for all dark cells ("M x y h1 v1 h-1 z" per cell), sized n x n. */
export function qrPath(matrix: boolean[][]): string {
  let d = "";
  matrix.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x} ${y}h1v1h-1z`; }));
  return d;
}
