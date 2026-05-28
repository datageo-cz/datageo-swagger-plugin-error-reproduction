import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";

async function bootstrap() {
	const app = await NestFactory.create(AppModule);

	// Triggers ItemDto._OPENAPI_METADATA_FACTORY, whose body the @nestjs/swagger
	// plugin compiles with a filesystem-relative require() pointing into the
	// sibling workspace package (../../../packages/shared/dist/messages/item).
	// In a deployed image where that relative path no longer exists, this throws
	// MODULE_NOT_FOUND.
	const document = SwaggerModule.createDocument(
		app,
		new DocumentBuilder().setTitle("Repro").build(),
	);
	SwaggerModule.setup("docs", app, document);

	await app.listen(3000);
}

bootstrap();
