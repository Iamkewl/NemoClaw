// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { getSandboxInventory, renderSandboxInventoryText } from "./inventory-commands";
import { buildListCommandDeps } from "./list-command-deps";

export default class ListCommand extends Command {
  static id = "list";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "List all sandboxes";
  static description =
    "List all registered sandboxes with their model, provider, and policy presets.";
  static usage = ["list [--json]"];
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  protected logJson(json: unknown): void {
    console.log(JSON.stringify(json, null, 2));
  }

  public async run(): Promise<unknown> {
    await this.parse(ListCommand);
    const inventory = await getSandboxInventory(buildListCommandDeps());
    if (this.jsonEnabled()) {
      return inventory;
    }

    renderSandboxInventoryText(inventory, this.log.bind(this));
  }
}
