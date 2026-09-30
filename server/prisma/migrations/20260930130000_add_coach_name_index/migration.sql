-- 搜老师按名字匹配（/api/coaches/search），没有索引时每次搜索都是全表扫
ALTER TABLE `Coach` ADD INDEX `Coach_name_idx` (`name`);
