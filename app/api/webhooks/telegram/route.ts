import { NextRequest, NextResponse } from "next/server";
import { classifyAndCreateTicket } from "@/lib/triage";
import { sendReply } from "@/lib/notify";

// Telegram doesn't require a GET verification handshake — POST only.
export async function POST(request: NextRequest) {
  const payload = await request.json();
  console.log("Telegram webhook payload:", JSON.stringify(payload));

  const message = payload?.message;
  if (!message?.text) {
    return new NextResponse("OK", { status: 200 });
  }

  const chatId = message.chat?.id;
  const firstName = message.from?.first_name;
  const username = message.from?.username;
  const messageText = message.text;

  console.log("Incoming Telegram message:", { chatId, firstName, username, messageText });

  try {
    const ticket = await classifyAndCreateTicket(
      messageText,
      String(chatId),
      firstName ?? username ?? null,
      "telegram",
      process.env.DEMO_ORG_ID!
    );
    console.log("Ticket created:", ticket.id, ticket.category, ticket.urgency);

    await sendReply(
      "telegram",
      String(chatId),
      `Thanks — I've logged your request as ticket #${ticket.id} (${ticket.category}). Our team will follow up shortly.`
    );
  } catch (error) {
    console.error("Failed to classify/create ticket or send reply:", error);
  }

  return new NextResponse("OK", { status: 200 });
}
