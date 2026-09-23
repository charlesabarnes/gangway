// `import x from "./a.svg" with { type: "text" }` gives the file's text (Bun).
declare module "*.svg" {
  const text: string;
  export default text;
}
