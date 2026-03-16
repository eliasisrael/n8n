# Workflow Catalog

Comparison of server workflow snapshots (`server/`) vs local implementations (`workflows/`).

---

## Implemented Locally

These server workflows have a corresponding `.js` file in `workflows/`.

| Server File | Workflow Name | Local File | Notes |
|---|---|---|---|
| activity-webhook.json | Activity Webhook | activity-webhook.js | |
| adapter-activities.json | Adapter: Activities | adapter-activities.js | |
| adapter-appearances.json | Adapter: Appearances | adapter-appearances.js | |
| adapter-book-endorsements.json | Adapter: Book Endorsements | adapter-endorsements.js | Filename mismatch |
| adapter-clients.json | Adapter: Clients | adapter-clients.js | |
| adapter-comms-pipeline.json | Adapter: Comms Pipeline | adapter-comms-pipeline.js | |
| adapter-contacts.json | Adapter: Contacts | adapter-contacts.js | |
| adapter-engagements.json | Adapter: Engagements | adapter-engagements.js | |
| adapter-partner-pipeline.json | Adapter: Partner Pipeline | adapter-partner-pipeline.js | |
| adapter-partners.json | Adapter: Partners | adapter-partners.js | |
| adapter-products.json | Adapter: Products | adapter-products.js | |
| adapter-sales-pipeline.json | Adapter: Sales Pipeline | adapter-sales-pipeline.js | |
| adapter-testimonials.json | Adapter: Testimonials | adapter-testimonials.js | |
| adapter-vf-notes.json | Adapter: VF Notes | adapter-vf-notes.js | |
| backfill-notionid-links.json | Backfill NOTIONID Links | backfill-notionid-links.js | |
| close-stale-task.json | Close Stale Task | close-stale-task.js | |
| contact-updates-from-notion.json | Contact Updates from Notion | contact-updates-from-notion.js | |
| create-or-update-mailchimp-record.json | Create or Update Mailchimp Record | create-or-update-mailchimp-record.js | |
| email-activity-log.json | Email Activity Log | email-activity-log.js | |
| find-duplicate-contacts.json | Find Duplicate Contacts | find-duplicate-contacts.js | |
| find-import-orphaned-mailchimp-members.json | Find & Import Orphaned Mailchimp Members | find-orphaned-mailchimp-members.js | Filename mismatch |
| ingest-substack-subscribers.json | Ingest Substack Subscribers | ingest-substack-subscribers.js | |
| linkedin-daily-topic-engine.json | LinkedIn Daily Topic Engine | topic-engine.js | Filename mismatch |
| mailchimp-audience-hook.json | Mailchimp Audience Hook | mailchimp-audience-hook.js | |
| mailchimp-audience-processor-*.json | Mailchimp Audience Processor | mailchimp-audience-processor.js | 2 server copies, 1 local file |
| mdi-subscriber-hook.json | MDI Subscriber Hook | mdi-subscriber-hook.js | |
| merge-duplicate-contacts.json | Merge Duplicate Contacts | merge-duplicate-contacts.js | |
| notion-master-contact-upsert-*.json | Notion Master Contact Upsert | upsert-contact.js | 2 server copies, filename mismatch |
| stage-entry-tasks.json | Stage Entry Tasks | stage-entry-tasks.js | |
| stale-pipeline-alerts.json | Stale Pipeline Alerts | stale-pipeline-alerts.js | |
| vf-notes-webhook.json | VF Notes Webhook | vf-notes-webhook.js | |
| appearances-management.json | Appearances Management | appearances-management.js | |
| book-endorsements-management.json | Book Endorsements Management | book-endorsements-management.js | |
| check-engagements.json | Check Engagements | check-engagements.js | |
| clients-management.json | Clients Management | clients-management.js | |
| copy-products-to-notion-and-mailchimp.json | Copy Products To Notion and Mailchimp | copy-products-to-notion-and-mailchimp.js | |
| create-or-update-product.json | Create or Update Product | create-or-update-product.js | |
| create-thinkific-store.json | Create Thinkific Store | create-thinkific-store.js | |
| error-handler.json | Error Handler | error-handler.js | |
| forecast-engine.json | Forecast Engine | forecast-engine.js | |
| handle-unsubs.json | Handle Unsubs | handle-unsubs.js | |
| lead-created.json | Lead Created | lead-created.js | |
| list-orders.json | List Orders | list-orders.js | |
| mdi-subscriber-bulk-upload.json | MDI Subscriber Bulk Upload | mdi-subscriber-bulk-upload.js | |
| notion-update-products.json | Notion: Update Products | notion-update-products.js | |
| order-created.json | Order Created | order-created.js | |
| partners-management.json | Partners Management | partners-management.js | |
| product-created.json | Product Created | product-created.js | |
| product-deleted.json | Product Deleted | product-deleted.js | |

## Managed by Patch Scripts

These workflows are maintained directly on the server via `patch-router*.js` scripts, not as standalone `.js` workflow files.

| Server File | Workflow Name |
|---|---|
| notion-webhook-router.json | Notion Webhook Router |
| notion-webhook-router-live.json | Notion Webhook Router |
| notion-webhook-router-pre-maintenance.json | Notion Webhook Router |

## To Implement

These server-only workflows need local `.js` implementations.

| Server File | Workflow Name |
|---|---|
| product-updated.json | Product Updated |
| products-management.json | Products Management |
| record-order.json | Record Order |
| refresh-all-products.json | Refresh All Products |
| store-lms-product.json | Store LMS Product |
| substack-rss-feed-to-webflow-blog-collection.json | Substack RSS Feed to Webflow Blog Collection |
| testimonials-management.json | Testimonials Management |

## To Archive

These workflows are deprecated or no longer needed. Can be deactivated and removed from the server.

| Server File | Workflow Name |
|---|---|
| attempt-tagging-of-vendors-and-buy-side.json | Attempt Tagging of Vendors and Buy Side |
| build-3-links-post.json | Build 3 Links Post |
| bulk-netbr-webinar-attendees.json | Bulk NetBR Webinar Attendees |
| capture-invoices-from-icloud-eli.json | Capture Invoices from iCloud (Eli) |
| categorize-notion-frustrations.json | Categorize Notion Frustrations |
| categorize-webflow-frustrations.json | Categorize Webflow Frustrations |
| community-error-handler.json | Community Error Handler |
| empire-flippers.json | Empire Flippers |
| get-open-access-articles.json | Get Open Access Articles |
| message-audit.json | Message Audit |
| my-workflow.json | My workflow |
| my-workflow-2.json | My workflow 2 |
| my-workflow-3.json | My workflow 3 |
| my-workflow-4.json | My workflow 4 |
| contacts-management.json | Contacts Management |
| watch-for-cloud-gateway-fiber.json | Watch for Cloud Gateway Fiber |

## Summary

- **Implemented locally**: 43 unique workflows (43 server files, due to duplicates)
- **Managed by patch scripts**: 1 workflow (3 server snapshots)
- **To implement**: 7 workflows
- **To archive**: 16 workflows
- **Local-only**: 1 file (`_example-http-poll.js` — example template)
- **Filename mismatches**: 4 (adapter-endorsements, find-orphaned-mailchimp-members, topic-engine, upsert-contact)
- **Server duplicates**: Notion Master Contact Upsert (2), Mailchimp Audience Processor (2), Notion Webhook Router (3)
