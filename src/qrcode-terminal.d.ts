declare module 'qrcode-terminal' {
  function generate(text: string, opts?: { small?: boolean }): void;
  function generate(
    text: string,
    opts: { small?: boolean } | undefined,
    cb: (qr: string) => void,
  ): void;
  export default { generate };
}
