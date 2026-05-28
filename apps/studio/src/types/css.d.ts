// Ambient declaration for side-effect CSS imports in the client. Bun's
// bundler handles the actual CSS; TypeScript just needs to know the imports
// are valid module specifiers.

declare module "*.css";
