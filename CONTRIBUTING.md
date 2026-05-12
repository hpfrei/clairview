# Contributing to vistaclair

Thanks for your interest in contributing! This project is open to contributions of all kinds — bug fixes, new features, documentation improvements, and ideas.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Getting Started

1. Fork the repository
2. Clone your fork and install dependencies:
   ```bash
   git clone https://github.com/<your-username>/vistaclair.git
   cd vistaclair
   npm install
   ```
3. Run `claude` once from the project directory to authenticate (see [README](README.md))
4. Start the dev server with file watching:
   ```bash
   npm run dev
   ```

## Making Changes

1. Create a branch for your work:
   ```bash
   git checkout -b my-feature
   ```
2. Make your changes
3. Test that the proxy and dashboard both work as expected
4. Commit with a clear message describing what and why

## Contributor License Agreement

Before we can merge your first pull request, you'll need to agree to our [Contributor License Agreement](CLA.md). This allows us to use your contributions in both the open-source and commercial editions of vistaclair while you retain full ownership of your work.

## Submitting a Pull Request

1. Push your branch to your fork
2. Open a pull request against `main`
3. Describe what your change does and why

## Reporting Bugs

Open an [issue](https://github.com/hpfrei/vistaclair/issues) with:

- What you expected to happen
- What actually happened
- Steps to reproduce

## Security Issues

Please do **not** open public issues for security vulnerabilities. See [SECURITY.md](SECURITY.md) for how to report them privately.

## Code Style

- Keep it simple — this is a small, focused tool
- No build step — plain Node.js on the server, vanilla JS in the browser
- Match the style of the existing code
