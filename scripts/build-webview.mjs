import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/webview/sidebarApp.tsx'],
  bundle: true,
  outfile: 'media/sidebar.js',
  platform: 'browser',
  format: 'iife',
  target: ['es2020'],
  minify: true,
  define: {
    'process.env.NODE_ENV': '"production"'
  },
  sourcemap: false,
  jsx: 'automatic',
  loader: {
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.css': 'css'
  },
  logLevel: 'info'
});
