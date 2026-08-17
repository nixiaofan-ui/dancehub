import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const cities = [
  { region: "CN", name: "上海" },
  { region: "OVERSEAS", name: "首尔" },
];

async function main() {
  for (const city of cities) {
    await prisma.city.upsert({
      where: { region_name: { region: city.region, name: city.name } },
      update: {},
      create: city,
    });
  }
  console.log("Seed done: 上海(CN), 首尔(OVERSEAS)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());