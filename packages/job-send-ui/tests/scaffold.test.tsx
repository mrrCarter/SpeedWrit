import { render, screen } from "@testing-library/react";

import { PACKAGE_NAME } from "../src/index";

test("the package exports its name", () => {
  expect(PACKAGE_NAME).toBe("@writ/job-send-ui");
});

test("components render under jsdom", () => {
  render(<p>Prohibited by your job: not approvable</p>);
  expect(screen.getByText("Prohibited by your job: not approvable")).toBeInTheDocument();
});
