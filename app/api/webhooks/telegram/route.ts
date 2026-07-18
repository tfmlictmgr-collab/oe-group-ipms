import { NextRequest, NextResponse } from "next/server";

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
  const date = message.date;

  console.log("Incoming Telegram message:", {
    chatId,
    firstName,
    username,
    messageText,
    date,
  });

  return new NextResponse("OK", { status: 200 });
}
