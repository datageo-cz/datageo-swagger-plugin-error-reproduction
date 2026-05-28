import { ItemStatus } from "@repro/shared/messages";

export class ItemDto {
	id!: string;
	status!: ItemStatus;
}
