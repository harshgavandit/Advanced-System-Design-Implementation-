resource "aws_vpc" "this" {

  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_subnet" "public" {

  count                   = 2
  vpc_id                  = aws_vpc.this.id
  availability_zone       = var.availability_zones[count.index]
  cidr_block              = cidrsubnet(aws_vpc.this.cidr_block, 8, count.index)
  map_public_ip_on_launch = false

}

resource "aws_subnet" "private" {

  count                   = 2
  vpc_id                  = aws_vpc.this.id
  availability_zone       = var.availability_zones[count.index]
  cidr_block              = cidrsubnet(aws_vpc.this.cidr_block, 8, count.index + 10)
  map_public_ip_on_launch = false

}

resource "aws_eip" "nat" {
  count  = 2
  domain = "vpc"

}

resource "aws_nat_gateway" "this" {

  count         = 2
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  depends_on    = [aws_internet_gateway.this]

}

resource "aws_route_table" "public" {

  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }


}

resource "aws_route_table" "private" {

  count  = 2
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[count.index].id
  }


}

resource "aws_route_table_association" "public" {

  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id

}

resource "aws_route_table_association" "private" {

  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id

}

resource "aws_security_group" "alb" {
  name   = "${local.name}-alb"
  vpc_id = aws_vpc.this.id

}

resource "aws_security_group" "tasks" {
  name   = "${local.name}-tasks"
  vpc_id = aws_vpc.this.id

}

resource "aws_security_group" "dependencies" {
  name   = "${local.name}-dependencies"
  vpc_id = aws_vpc.this.id

}

resource "aws_vpc_security_group_ingress_rule" "https" {

  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443

}

resource "aws_vpc_security_group_ingress_rule" "api" {

  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 5002
  to_port                      = 5002

}

resource "aws_vpc_security_group_egress_rule" "alb_api" {

  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 5002
  to_port                      = 5002

}

resource "aws_vpc_security_group_egress_rule" "tasks_https" {

  security_group_id = aws_security_group.tasks.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443

}

# Atlas PrivateLink uses its dynamically assigned port-mapped TCP range.
resource "aws_vpc_security_group_egress_rule" "task_dependency" {

  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.dependencies.id
  ip_protocol                  = "tcp"
  from_port                    = 1024
  to_port                      = 65535

}

resource "aws_vpc_security_group_ingress_rule" "dependency_tasks" {

  security_group_id            = aws_security_group.dependencies.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 1024
  to_port                      = 65535

}

resource "aws_vpc_security_group_ingress_rule" "endpoint_https" {

  security_group_id            = aws_security_group.dependencies.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443

}

resource "aws_vpc_endpoint" "services" {

  for_each            = toset(["ecr.api", "ecr.dkr", "logs", "sqs", "secretsmanager", "monitoring"])
  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.dependencies.id]
  private_dns_enabled = true

}

resource "aws_vpc_endpoint" "s3" {

  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id

}

