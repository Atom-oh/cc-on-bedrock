# Preserve existing dedicated-network state addresses when adding optional VPC
# reuse. Keep these migrations so older deployments can upgrade directly.
moved {
  from = aws_vpc.this
  to   = aws_vpc.this[0]
}
moved {
  from = aws_internet_gateway.this
  to   = aws_internet_gateway.this[0]
}
moved {
  from = aws_subnet.public_a
  to   = aws_subnet.public_a[0]
}
moved {
  from = aws_subnet.public_c
  to   = aws_subnet.public_c[0]
}
moved {
  from = aws_route_table.public
  to   = aws_route_table.public[0]
}
moved {
  from = aws_route.public_internet
  to   = aws_route.public_internet[0]
}
moved {
  from = aws_route_table_association.public_a
  to   = aws_route_table_association.public_a[0]
}
moved {
  from = aws_route_table_association.public_c
  to   = aws_route_table_association.public_c[0]
}
moved {
  from = aws_eip.nat_a
  to   = aws_eip.nat_a[0]
}
moved {
  from = aws_eip.nat_c
  to   = aws_eip.nat_c[0]
}
moved {
  from = aws_nat_gateway.a
  to   = aws_nat_gateway.a[0]
}
moved {
  from = aws_nat_gateway.c
  to   = aws_nat_gateway.c[0]
}
moved {
  from = aws_subnet.private_a
  to   = aws_subnet.private_a[0]
}
moved {
  from = aws_subnet.private_c
  to   = aws_subnet.private_c[0]
}
moved {
  from = aws_route_table.private_a
  to   = aws_route_table.private_a[0]
}
moved {
  from = aws_route_table.private_c
  to   = aws_route_table.private_c[0]
}
moved {
  from = aws_route.private_nat_a
  to   = aws_route.private_nat_a[0]
}
moved {
  from = aws_route.private_nat_c
  to   = aws_route.private_nat_c[0]
}
moved {
  from = aws_route_table_association.private_a
  to   = aws_route_table_association.private_a[0]
}
moved {
  from = aws_route_table_association.private_c
  to   = aws_route_table_association.private_c[0]
}
moved {
  from = aws_subnet.isolated_a
  to   = aws_subnet.isolated_a[0]
}
moved {
  from = aws_subnet.isolated_c
  to   = aws_subnet.isolated_c[0]
}
moved {
  from = aws_route_table.isolated
  to   = aws_route_table.isolated[0]
}
moved {
  from = aws_route_table_association.isolated_a
  to   = aws_route_table_association.isolated_a[0]
}
moved {
  from = aws_route_table_association.isolated_c
  to   = aws_route_table_association.isolated_c[0]
}
moved {
  from = aws_security_group.vpc_endpoints
  to   = aws_security_group.vpc_endpoints[0]
}
moved {
  from = aws_vpc_endpoint.s3
  to   = aws_vpc_endpoint.s3[0]
}
