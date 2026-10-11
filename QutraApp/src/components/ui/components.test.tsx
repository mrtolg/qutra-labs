import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Segmented } from "./Segmented";
import { ConfirmDialog } from "./ConfirmDialog";
import { Dialog } from "./Dialog";
import { Markdown } from "./Markdown";
import { ensureLocaleLoaded, translate } from "@/lib/i18n";

describe("Segmented", () => {
  it("renders options with pressed state and fires onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Segmented
        ariaLabel="View"
        value="list"
        onChange={onChange}
        options={[
          { value: "list", label: "List" },
          { value: "board", label: "Board" },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Board" }));
    expect(onChange).toHaveBeenCalledWith("board");
  });
});

describe("Dialog", () => {
  it("returns focus to the opener when closed via the close button", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open dialog
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} title="Sample">
            <p>Body</p>
          </Dialog>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open dialog" });
    await user.click(opener);
    expect(screen.getByRole("heading", { name: "Sample" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });
});

describe("ConfirmDialog", () => {
  it("blocks confirm until the type-to-confirm word matches", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete everything?"
        body="This cannot be undone."
        confirmLabel="Delete"
        danger
        typeToConfirm="DELETE"
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    const confirm = screen.getByRole("button", { name: "Delete" });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText("DELETE"), "DELETE");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalled();
  });
});

describe("Markdown", () => {
  it("renders markdown without injecting HTML", () => {
    const { container } = render(
      <Markdown source={"# Title\n\n**bold** and <script>alert(1)</script>\n\n- item"} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("bold")).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent("item");
  });

  it("renders wikilinks as buttons when a handler is provided", async () => {
    const user = userEvent.setup();
    const onWikiLink = vi.fn();
    render(<Markdown source="See [[Other note]]" onWikiLink={onWikiLink} />);
    await user.click(screen.getByRole("button", { name: "Other note" }));
    expect(onWikiLink).toHaveBeenCalledWith("Other note");
  });
});

describe("i18n", () => {
  it("translates with params in both locales and falls back to en", async () => {
    await ensureLocaleLoaded("tr");
    expect(translate("en", "common.results", { count: 3 })).toBe("3 results");
    expect(translate("tr", "common.results", { count: 3 })).toBe("3 sonuç");
    expect(translate("tr", "app.name")).toBe("Qutra Labs");
  });
});
