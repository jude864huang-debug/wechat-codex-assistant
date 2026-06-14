declare module "qrcode-terminal" {
  export function generate(input: string, options?: { small?: boolean }, callback?: (qr: string) => void): void;
  const api: { generate: typeof generate };
  export default api;
}
