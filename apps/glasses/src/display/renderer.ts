import {
  CreateStartUpPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk';
import type { GlassesBridge } from '../bridge';

export interface TextSpec {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  content: string;
  /** 0..4; omit to inherit the device default. */
  brightness?: number;
  borderWidth?: number;
  borderColor?: number;
  borderRadius?: number;
  padding?: number;
  /** Exactly one container per page must set this. */
  capture?: boolean;
}

export interface MenuSpec {
  itemID: number;
  itemName: string;
}

export interface PageSpec {
  containers: TextSpec[];
  menu?: MenuSpec[];
}

function toContainer(spec: TextSpec): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: spec.x,
    yPosition: spec.y,
    width: spec.width,
    height: spec.height,
    borderWidth: spec.borderWidth ?? 0,
    borderColor: spec.borderColor ?? 0,
    borderRadius: spec.borderRadius ?? 0,
    paddingLength: spec.padding ?? 0,
    containerID: spec.id,
    containerName: spec.name,
    isEventCapture: spec.capture ? 1 : 0,
    content: spec.content,
    ...(spec.brightness === undefined ? {} : { textColor: spec.brightness }),
  });
}

function toMenu(items: MenuSpec[] | undefined): MenuContainerProperty | undefined {
  if (!items || items.length === 0) return undefined;
  return new MenuContainerProperty({
    menuItems: items.map((i) => new MenuItemProperty({ itemID: i.itemID, itemName: i.itemName })),
  });
}

/** Everything except text content — a change here forces a full rebuild. */
function layoutSignature(page: PageSpec): string {
  return JSON.stringify([
    page.containers.map((c) => [
      c.id,
      c.name,
      c.x,
      c.y,
      c.width,
      c.height,
      c.borderWidth ?? 0,
      c.borderColor ?? 0,
      c.borderRadius ?? 0,
      c.padding ?? 0,
      c.capture ? 1 : 0,
      c.brightness ?? -1,
    ]),
    page.menu?.map((m) => [m.itemID, m.itemName]) ?? null,
  ]);
}

export class RenderError extends Error {}

/**
 * Owns the glasses display.
 *
 * `createStartUpPageContainer` may only be called once per app launch, so the
 * first render mounts and every later render either upgrades text in place
 * (flicker-free) or rebuilds the whole page when the layout itself changed.
 */
export class Renderer {
  private mounted = false;
  private signature = '';
  private contents = new Map<number, string>();

  constructor(private readonly bridge: GlassesBridge) {}

  get isMounted(): boolean {
    return this.mounted;
  }

  async render(page: PageSpec): Promise<void> {
    if (!this.mounted) {
      await this.mount(page);
      return;
    }

    const signature = layoutSignature(page);
    if (signature !== this.signature) {
      await this.rebuild(page, signature);
      return;
    }

    // Same layout: push only the containers whose text actually moved.
    for (const spec of page.containers) {
      if (this.contents.get(spec.id) === spec.content) continue;

      const ok = await this.bridge.run('textContainerUpgrade', (b) =>
        b.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: spec.id,
            containerName: spec.name,
            // 0/0 replaces the whole string rather than splicing into it.
            contentOffset: 0,
            contentLength: 0,
            content: spec.content,
            ...(spec.brightness === undefined ? {} : { textColor: spec.brightness }),
          }),
        ),
      );

      if (!ok) {
        // An in-place update can fail if the firmware dropped the container;
        // a rebuild always re-establishes it.
        await this.rebuild(page, signature);
        return;
      }
      this.contents.set(spec.id, spec.content);
    }
  }

  private async mount(page: PageSpec): Promise<void> {
    const menu = toMenu(page.menu);
    const payload = new CreateStartUpPageContainer({
      containerTotalNum: page.containers.length,
      textObject: page.containers.map(toContainer),
      ...(menu ? { menuObject: menu } : {}),
    });

    const result = await this.bridge.run(
      'createStartUpPageContainer',
      (b) => b.createStartUpPageContainer(payload),
      12_000,
    );

    if (result !== StartUpPageCreateResult.success) {
      throw new RenderError(
        `createStartUpPageContainer returned ${StartUpPageCreateResult[result] ?? result}`,
      );
    }

    this.mounted = true;
    this.signature = layoutSignature(page);
    this.contents = new Map(page.containers.map((c) => [c.id, c.content]));
  }

  private async rebuild(page: PageSpec, signature: string): Promise<void> {
    const menu = toMenu(page.menu);
    const payload = new RebuildPageContainer({
      containerTotalNum: page.containers.length,
      textObject: page.containers.map(toContainer),
      ...(menu ? { menuObject: menu } : {}),
    });

    const ok = await this.bridge.run('rebuildPageContainer', (b) => b.rebuildPageContainer(payload));
    if (!ok) throw new RenderError('rebuildPageContainer was rejected');

    this.signature = signature;
    this.contents = new Map(page.containers.map((c) => [c.id, c.content]));
  }
}
