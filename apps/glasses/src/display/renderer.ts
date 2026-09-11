import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
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
  /**
   * Stacking order, larger in front. All-or-nothing per page: either every
   * container sets a unique value or none do, or the SDK rejects the payload.
   */
  zOrder?: number;
}

/**
 * An image container. Firmware limits: 20-288 wide, 20-144 tall, four per page.
 *
 * These never capture events, so a page with images still needs a text
 * container carrying `isEventCapture`.
 */
export interface ImageSpec {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zOrder?: number;
}

export interface MenuSpec {
  itemID: number;
  itemName: string;
}

export interface PageSpec {
  containers: TextSpec[];
  images?: ImageSpec[];
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
    ...(spec.zOrder === undefined ? {} : { zOrderIndex: spec.zOrder }),
  });
}

function toImageContainer(spec: ImageSpec): ImageContainerProperty {
  return new ImageContainerProperty({
    xPosition: spec.x,
    yPosition: spec.y,
    width: spec.width,
    height: spec.height,
    containerID: spec.id,
    containerName: spec.name,
    ...(spec.zOrder === undefined ? {} : { zOrderIndex: spec.zOrder }),
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
      c.zOrder ?? -1,
    ]),
    page.images?.map((i) => [i.id, i.name, i.x, i.y, i.width, i.height, i.zOrder ?? -1]) ?? null,
    page.menu?.map((m) => [m.itemID, m.itemName]) ?? null,
  ]);
}

/** Total containers, which the firmware caps at twelve. */
function containerCount(page: PageSpec): number {
  return page.containers.length + (page.images?.length ?? 0);
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

  /**
   * Draws a page.
   *
   * Returns whether the page was structurally (re)built, because that clears
   * every image container — the caller has to push its pixels again.
   */
  async render(page: PageSpec): Promise<{ rebuilt: boolean }> {
    if (!this.mounted) {
      await this.mount(page);
      return { rebuilt: true };
    }

    const signature = layoutSignature(page);
    if (signature !== this.signature) {
      await this.rebuild(page, signature);
      return { rebuilt: true };
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
        return { rebuilt: true };
      }
      this.contents.set(spec.id, spec.content);
    }

    return { rebuilt: false };
  }

  /**
   * Sends pixels to an image container.
   *
   * Slow — half a second to two seconds over BLE — and the SDK forbids
   * overlapping calls, so this goes through the same serialising queue as
   * everything else and gets a longer timeout.
   */
  async pushImage(spec: ImageSpec, pixels: Uint8Array): Promise<void> {
    const result = await this.bridge.run(
      'updateImageRawData',
      (b) =>
        b.updateImageRawData(
          new ImageRawDataUpdate({
            containerID: spec.id,
            containerName: spec.name,
            imageData: pixels,
          }),
        ),
      20_000,
    );

    if (result !== ImageRawDataUpdateResult.success) {
      throw new RenderError(`updateImageRawData returned ${result}`);
    }
  }

  private async mount(page: PageSpec): Promise<void> {
    const menu = toMenu(page.menu);
    const payload = new CreateStartUpPageContainer({
      containerTotalNum: containerCount(page),
      textObject: page.containers.map(toContainer),
      ...(page.images?.length ? { imageObject: page.images.map(toImageContainer) } : {}),
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
      containerTotalNum: containerCount(page),
      textObject: page.containers.map(toContainer),
      ...(page.images?.length ? { imageObject: page.images.map(toImageContainer) } : {}),
      ...(menu ? { menuObject: menu } : {}),
    });

    const ok = await this.bridge.run('rebuildPageContainer', (b) => b.rebuildPageContainer(payload));
    if (!ok) throw new RenderError('rebuildPageContainer was rejected');

    this.signature = signature;
    this.contents = new Map(page.containers.map((c) => [c.id, c.content]));
  }
}
