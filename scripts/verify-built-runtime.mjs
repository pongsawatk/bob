// Import the compiled entry point in native Node, without tsx's module loader.
// No requests or external calls: this catches runtime-only module format errors.
process.env.OPENROUTER_API_KEY ||= 'runtime-import-check';
await import('../dist-ts/api/chat.js');
console.log('Compiled API imports successfully in native Node.');
