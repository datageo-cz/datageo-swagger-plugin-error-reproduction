import { Controller, Get } from "@nestjs/common";
import { ApiResponse } from "@nestjs/swagger";
import { ItemDto } from "./item.dto";

@Controller("items")
export class ItemsController {
	@Get()
	@ApiResponse({ type: [ItemDto] })
	list(): ItemDto[] {
		return [];
	}
}
