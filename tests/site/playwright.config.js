const { defineConfig, devices } = require('@playwright/test');

const PORT = 8765;
module.exports = defineConfig({
  testDir: '.',
  timeout: 5 * 60 * 1000,
  reporter: process.env.CI ? [['list'], ['junit', { outputFile: 'results.xml' }]] : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, timezoneId: 'Europe/Berlin', locale: 'en-GB' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  // the data in pieces, as the collector would write it from the fixture
  webServer: { command: 'rm -rf .chunks && PYTHONPATH=../../collector python3 -m valheim_gamestats.chunks fixture/data.json .chunks && node serve.js', port: PORT, env: { PORT: String(PORT) }, reuseExistingServer: !process.env.CI },
});
