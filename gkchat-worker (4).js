// GrowthKitty Chat — Cloudflare Worker
// Receives email + transcript from the website chat widget.
// Finds the contact in HubSpot, then attaches a Note to their timeline.
//
// SETUP:
// 1. Deploy this file to your Cloudflare Worker (gkchat)
// 2. Go to Worker Settings → Variables → Add variable
//    Name:  HUBSPOT_TOKEN
//    Value: your HubSpot Private App token (pat-na1-...)
//    Tick "Encrypt" to keep it secret

export default {
  async fetch(request, env) {

    // Allow the GrowthKitty website to call this Worker
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json"
    };

    // Browser sends a preflight OPTIONS request before POST — just say yes
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Only POST requests accepted" }),
        { status: 405, headers: corsHeaders }
      );
    }

    // ── Read the request body ──────────────────────────────
    let email, note;
    try {
      const body = await request.json();
      email = body.email;
      note  = body.note;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: corsHeaders }
      );
    }

    if (!email || !note) {
      return new Response(
        JSON.stringify({ error: "Both email and note are required" }),
        { status: 400, headers: corsHeaders }
      );
    }

    // ── Check token is configured ──────────────────────────
    const TOKEN = env.HUBSPOT_TOKEN;
    if (!TOKEN) {
      return new Response(
        JSON.stringify({ error: "HUBSPOT_TOKEN not set in Worker environment variables" }),
        { status: 500, headers: corsHeaders }
      );
    }

    const hs = (url, method, body) =>
      fetch("https://api.hubapi.com" + url, {
        method,
        headers: {
          "Authorization": "Bearer " + TOKEN,
          "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined
      });

    try {

      // ── Step 1: Find the contact by email ─────────────────
      const searchRes  = await hs("/crm/v3/objects/contacts/search", "POST", {
        filterGroups: [{
          filters: [{ propertyName: "email", operator: "EQ", value: email }]
        }],
        properties: ["email", "firstname", "lastname"],
        limit: 1
      });
      const searchData = await searchRes.json();
      const contact    = searchData.results?.[0];

      if (!contact) {
        // Not found yet — the HubSpot form submission may still be processing.
        // The transcript is already saved in the form message field as a fallback.
        return new Response(
          JSON.stringify({ warning: "Contact not yet in HubSpot", email }),
          { status: 404, headers: corsHeaders }
        );
      }

      const contactId = contact.id;

      // ── Step 2: Create a Note with the full analysis ───────
      // associationTypeId 202 = note → contact (HubSpot built-in)
      const noteRes  = await hs("/crm/v3/objects/notes", "POST", {
        properties: {
          hs_timestamp: new Date().toISOString(),
          hs_note_body: note
        },
        associations: [{
          to:    { id: contactId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }]
        }]
      });
      const noteData = await noteRes.json();

      if (!noteRes.ok) {
        return new Response(
          JSON.stringify({ error: "HubSpot note creation failed", detail: noteData }),
          { status: 500, headers: corsHeaders }
        );
      }

      // Success — Note is now on the contact's activity timeline in HubSpot
      return new Response(
        JSON.stringify({ success: true, noteId: noteData.id, contactId }),
        { status: 200, headers: corsHeaders }
      );

    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: corsHeaders }
      );
    }
  }
};
