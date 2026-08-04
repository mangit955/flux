# Flux Web App

Trading platform frontend built with Next.js.

## Quick Start

### Local Development

1. **Copy environment variables:**
   ```bash
   cp .env.example .env.local
   ```

2. **Update `.env.local` with your backend URLs:**
   ```bash
   NEXT_PUBLIC_API_URL=http://localhost:3000
   NEXT_PUBLIC_WS_URL=ws://localhost:3000/ws
   NEXT_PUBLIC_USE_REAL_API=true
   ```

3. **Check configuration:**
   ```bash
   npm run check-config
   ```

4. **Start the development server:**
   ```bash
   npm run dev
   ```

5. **Open your browser:**
   ```
   http://localhost:3001
   ```

## Deployment

### Deploy to Vercel

1. **Update `.env.production` with your production backend URLs:**
   ```bash
   NEXT_PUBLIC_API_URL=https://your-backend.com
   NEXT_PUBLIC_WS_URL=wss://your-backend.com/ws
   NEXT_PUBLIC_USE_REAL_API=true
   ```

2. **Deploy:**
   ```bash
   # Preview deployment
   npm run deploy:preview

   # Production deployment
   npm run deploy
   ```

   Or use the Vercel dashboard:
   - Import repository
   - Set root directory to `apps/web`
   - Add environment variables
   - Deploy

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `NEXT_PUBLIC_API_URL` | Backend API URL | `http://localhost:3000` or `https://api.example.com` |
| `NEXT_PUBLIC_WS_URL` | WebSocket URL | `ws://localhost:3000/ws` or `wss://api.example.com/ws` |
| `NEXT_PUBLIC_USE_REAL_API` | Enable real API (vs mock) | `true` |

**Important:** All variables must start with `NEXT_PUBLIC_` to be accessible in the browser.

## Troubleshooting

### Configuration Issues

Run the configuration checker:
```bash
npm run check-config
```

### WebSocket Connection Failed

1. Check that backend is running
2. Verify WebSocket URL in `.env.local`
3. For production, ensure URL uses `wss://` (not `ws://`)
4. Check browser console for detailed errors

### Orders Not Working

1. Verify `NEXT_PUBLIC_USE_REAL_API=true`
2. Check backend API is accessible
3. Verify token is present (check localStorage)
4. Check browser network tab for failed requests

### CORS Errors

Ensure backend CORS configuration includes your frontend domain. Update `apps/api/src/app.ts`:

```typescript
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://your-frontend.vercel.app",
  // ...
};
```

## Features

- Real-time trading interface
- WebSocket integration for live updates
- Position management
- Order book visualization
- Trade history
- Dark mode UI

## Tech Stack

- **Framework:** Next.js 16
- **UI:** React 19, Tailwind CSS
- **Charts:** Lightweight Charts
- **Tables:** TanStack Table
- **WebSocket:** Native WebSocket API
- **Deployment:** Vercel

## Project Structure

```
apps/web/
├── app/               # Next.js app router
├── components/        # React components
├── hooks/             # Custom React hooks
├── lib/               # Utilities and API client
├── types/             # TypeScript types
├── .env.local         # Local environment variables
├── .env.production    # Production environment variables
└── check-config.js    # Configuration validator
```

## Development

### Check Types

```bash
npm run check-types
```

### Lint

```bash
npm run lint
```

### Build

```bash
npm run build
```

## Links

- [Backend API Docs](../../apps/docs)
- [Architecture](../../CLAUDE.md)
- [Known issues](../../TODO.md)
