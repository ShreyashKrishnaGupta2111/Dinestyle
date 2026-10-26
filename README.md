# Dinestyle
Dinestyle

# VELVET TABLE — QR Restaurant Ordering

A mobile-first multi-cuisine restaurant menu with QR access,
dine-in and takeaway ordering, Razorpay checkout, PayPal
checkout, and cash-at-restaurant orders.

## Project files

- `index.html` — website and menu
- `server.js` — payment API and order processing
- `package.json` — Node.js dependencies
- `.env.example` — configuration template
- `.gitignore` — protects secrets and local files

## Publish the frontend

1. Create a GitHub repository named `velvet-table-qr-menu`.
2. Upload `index.html` to the repository root.
3. Open Settings > Pages.
4. Select deployment from the `main` branch and root folder.
5. Copy your published website URL.
6. Replace `API_BASE` in `index.html` with your deployed
   backend HTTPS URL.
7. Commit the updated file.

GitHub Pages hosts the frontend. It does not run `server.js`.

## Run the backend locally

Install Node.js 20 or newer.

```bash
npm install
```

Copy `.env.example` to `.env`, then configure your test
credentials and frontend origin.

```bash
npm start
```

Visit `/health` on your backend to check that it is running.

## Razorpay

1. Create or sign in to a Razorpay account.
2. Start with Test Mode API keys.
3. Configure `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
4. Test order creation and checkout.
5. Verify payment signatures and payment status on the server.
6. Complete the provider's onboarding requirements before
   enabling live payments.

## PayPal

1. Create a PayPal Developer account and sandbox REST app.
2. Configure the sandbox Client ID and Secret on the backend.
3. Set `PAYPAL_ENV=sandbox`.
4. Configure the return and cancel URLs.
5. Test order approval and server-side capture.

IMPORTANT: Check PayPal merchant eligibility and supported
currencies for your account. INR may not be available for
your intended merchant/payment flow. Do not enable PayPal
for customers until you have confirmed currency support.
If required, implement a supported currency and clearly
display the amount and conversion rules to customers.

## QR codes

Use the QR button on the website to generate a menu QR code.

For table-specific QR codes, use URLs like:

`https://YOUR-GITHUB-USERNAME.github.io/velvet-table-qr-menu/?table=05`

Print a different table number for each dine-in table.
Scan every printed QR with a phone before using it.

## Before production

- Replace the demo tax calculation with your actual billing rules.
- Keep frontend and backend menu prices synchronized.
- Use persistent database storage on your hosting platform.
- Add an authenticated staff dashboard.
- Add kitchen notifications, order acceptance and availability controls.
- Configure payment webhooks, idempotency and reconciliation.
- Add privacy, data-retention and refund/cancellation processes.
- Test successful, failed, cancelled and delayed payments.
- Keep payment secrets in backend environment variables.

The starter project does not yet include a staff dashboard,
refund management, inventory management or kitchen notifications.

## API routes

- `GET /health`
- `POST /api/razorpay/create-order`
- `POST /api/razorpay/verify`
- `POST /api/paypal/create-order`
- `POST /api/paypal/capture-order`
- `GET /paypal/return`
- `GET /paypal/cancel`
- `POST /api/cash-order`
