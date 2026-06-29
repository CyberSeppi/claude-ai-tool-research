import { test, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChatBox } from "./ChatBox";

test("ChatBox sends message and shows the answer", async () => {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ answer: "hello answer" }), { status: 200, headers: { "content-type": "application/json" } })
  ) as any;
  render(<ChatBox scope="record" ids={["a-b"]} title="Ask" />);
  fireEvent.change(screen.getByPlaceholderText(/ask/i), { target: { value: "what is this?" } });
  fireEvent.click(screen.getByRole("button", { name: /send/i }));
  await waitFor(() => expect(screen.getByText("hello answer")).toBeTruthy());
});
