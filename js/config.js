/*
 * Site owner settings.
 *
 * Stripe (payments for the plans). zoope has no server, so it uses Stripe Payment Links: Stripe hosts the
 * checkout page and handles the card; zoope never sees payment details.
 *   1. In the Stripe Dashboard, create a product and a recurring price for each paid plan (Pro, Team).
 *   2. Product catalog → Payment Links → New: one link per plan. Under "After payment", choose
 *      "Don't show confirmation page" and redirect to
 *        https://YOUR-SITE/?paid=pro&session_id={CHECKOUT_SESSION_ID}     (paid=team for the Team link)
 *   3. Paste the links below (they look like https://buy.stripe.com/...). For testing, use test-mode links.
 *   4. Optional: Settings → Billing → Customer portal → copy the portal link into `portal`, so users can
 *      change or cancel their subscription from Setup.
 * Leave a link empty and that plan stays a free demo (no payment).
 *
 * Note: without a server, zoope trusts Stripe's redirect back to the site to mark a plan as paid. To
 * enforce payment for real, check the session_id (or a Stripe webhook) on a server you control.
 */
window.ZOOPE_CONFIG = {
  stripe: {
    links: { pro: '', team: '' },
    portal: ''
  }
};
