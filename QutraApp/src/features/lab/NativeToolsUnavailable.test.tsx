import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { NativeToolsUnavailable } from "./NativeToolsUnavailable";

/* Outside the desktop app the registered tools say what is missing. They
   never print a developer command: a person using the installed app has no
   source folder to run it in. */
describe("NativeToolsUnavailable", () => {
  it("tells the user to open the desktop app without printing a developer command", () => {
    const { container } = render(
      <MemoryRouter>
        <NativeToolsUnavailable />
      </MemoryRouter>,
    );

    expect(screen.getByText("Running tools needs the desktop app")).toBeInTheDocument();
    expect(screen.getByText(/Open the desktop app and turn on Private Lab/)).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/npm run|tauri dev/);
    expect(screen.queryByRole("button", { name: "Copy the desktop command" })).toBeNull();
  });
});
