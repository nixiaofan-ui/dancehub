const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const p = new PrismaClient();
p.city
  .findMany({
    orderBy: { id: "asc" },
    include: { _count: { select: { studios: { where: { status: true } } } } },
  })
  .then((rows) => {
    const out = rows
      .filter((c) => c._count.studios > 0)
      .map((c) => ({
        id: c.id,
        name: c.name,
        region: c.region,
        studioCount: c._count.studios,
      }));
    fs.writeFileSync("/tmp/dh-cities.json", JSON.stringify(out, null, 0), "utf8");
    console.log("导出城市", out.length);
  })
  .catch((e) => console.error("ERR", e.message))
  .finally(() => p.$disconnect());
